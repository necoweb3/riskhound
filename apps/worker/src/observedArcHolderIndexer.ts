import { prisma } from "@rugkiller/db";
import { OBSERVED_ARC_CHAIN, shouldIgnoreForOwnership } from "@rugkiller/shared";

/**
 * Chain 5042 has no public explorer, so holder distribution and the creator
 * address used to be unavailable there. Both are recoverable from the node:
 * ERC-20 balances are the running sum of Transfer events, and the creator is
 * the sender of the transaction that produced the contract.
 *
 * The reconstruction is checked against balanceOf before it is stored, so a
 * missed log surfaces as a mismatch rather than as a confident wrong number.
 */

const RPC = () => process.env.OBSERVED_ARC_RPC_URL ?? "https://5042.rpc.thirdweb.com";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO = "0x0000000000000000000000000000000000000000";

/** The provider caps a log query at 1000 blocks regardless of result size. */
const MAX_LOG_RANGE = 1000;
/** Bound the work a single tick may do, so one huge token cannot stall the loop. */
const MAX_RANGE_PER_RUN = 300_000;
const TOKENS_PER_RUN = Number(process.env.OBSERVED_ARC_HOLDER_BATCH ?? 3);

type Log = { topics: string[]; data: string; blockNumber: string; transactionHash: string };

let rpcId = 0;

async function rpc<T>(method: string, params: unknown[], timeoutMs = 20_000): Promise<T> {
  const res = await fetch(RPC(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message ?? "rpc error"}`);
  return body.result as T;
}

const hex = (n: number) => `0x${n.toString(16)}`;
const addrFromTopic = (topic: string) => `0x${topic.slice(26)}`.toLowerCase();

async function hasCodeAt(address: string, block: number) {
  const code = await rpc<string>("eth_getCode", [address, hex(block)]);
  return Boolean(code) && code !== "0x";
}

/**
 * First block at which the contract has bytecode. Needs an archive node; if
 * historical state is unavailable every probe answers the same way and the
 * search returns 0, which the caller treats as unknown rather than as block 0.
 */
async function findDeployBlock(address: string, head: number): Promise<number | null> {
  if (!(await hasCodeAt(address, head))) return null;
  if (await hasCodeAt(address, 1)) return null; // archive not available, or genesis
  let lo = 1;
  let hi = head;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (await hasCodeAt(address, mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** The account that sent the contract-creating transaction. */
async function findCreator(address: string, deployBlock: number): Promise<string | null> {
  const block = await rpc<{ transactions?: { hash: string; from?: string; to?: string | null }[] }>(
    "eth_getBlockByNumber",
    [hex(deployBlock), true]
  ).catch(() => null);
  for (const tx of block?.transactions ?? []) {
    if (tx.to) continue; // only creations have a null recipient
    const receipt = await rpc<{ contractAddress?: string | null }>(
      "eth_getTransactionReceipt",
      [tx.hash]
    ).catch(() => null);
    if (receipt?.contractAddress?.toLowerCase() === address.toLowerCase()) {
      return tx.from?.toLowerCase() ?? null;
    }
  }
  return null;
}

async function balanceOf(token: string, holder: string): Promise<bigint | null> {
  const data = `0x70a08231${holder.slice(2).toLowerCase().padStart(64, "0")}`;
  const raw = await rpc<string>("eth_call", [{ to: token, data }, "latest"]).catch(() => null);
  if (!raw || raw === "0x") return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

async function scanTransfers(token: string, fromBlock: number, toBlock: number) {
  const deltas = new Map<string, bigint>();
  const bump = (a: string, v: bigint) => deltas.set(a, (deltas.get(a) ?? 0n) + v);
  let logCount = 0;
  let scannedTo = fromBlock - 1;

  for (let from = fromBlock; from <= toBlock; from += MAX_LOG_RANGE) {
    const to = Math.min(from + MAX_LOG_RANGE - 1, toBlock);
    const logs = await rpc<Log[]>("eth_getLogs", [
      { address: token, topics: [TRANSFER], fromBlock: hex(from), toBlock: hex(to) },
    ]);
    for (const log of logs) {
      // Transfer(address,address,uint256) indexes both parties. A 2-topic log
      // is a different event that happens to share the signature hash.
      if (log.topics.length < 3) continue;
      let value: bigint;
      try {
        value = BigInt(log.data === "0x" ? "0x0" : log.data);
      } catch {
        continue;
      }
      bump(addrFromTopic(log.topics[1]), -value);
      bump(addrFromTopic(log.topics[2]), value);
      logCount++;
    }
    scannedTo = to;
  }

  return { deltas, logCount, scannedTo };
}

async function indexToken(row: {
  id: string;
  address: string;
  deployBlock: bigint | null;
  totalSupply: string | null;
  deployer: string | null;
}, head: number) {
  const cursorKey = `observed_arc_holders:${row.address}`;
  const cursor = await prisma.indexerCursor.findUnique({ where: { key: cursorKey } });
  const lastScanned = cursor ? Number(cursor.lastBlock) : 0;

  let deployBlock = row.deployBlock != null ? Number(row.deployBlock) : null;
  if (!lastScanned && deployBlock == null) {
    deployBlock = await findDeployBlock(row.address, head);
    if (deployBlock == null) return { address: row.address, skipped: "deploy_block_unknown" };
  }

  const from = lastScanned > 0 ? lastScanned + 1 : deployBlock!;
  if (from > head) return { address: row.address, skipped: "up_to_date" };
  // Cap the window so a cold token cannot monopolise the tick.
  const to = Math.min(head, from + MAX_RANGE_PER_RUN - 1);

  const { deltas, logCount, scannedTo } = await scanTransfers(row.address, from, to);

  // Fold the new deltas into the balances already stored for this token.
  const existing = await prisma.tokenHolder.findMany({
    where: { tokenId: row.id },
    select: { address: true, balance: true },
  });
  const balances = new Map<string, bigint>();
  for (const h of existing) {
    try {
      balances.set(h.address, BigInt(h.balance));
    } catch {
      /* a corrupt row is rebuilt from the deltas */
    }
  }
  for (const [addr, delta] of deltas) {
    balances.set(addr, (balances.get(addr) ?? 0n) + delta);
  }
  balances.delete(ZERO);

  const holders = [...balances.entries()]
    .filter(([, v]) => v > 0n)
    .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));

  // Verify the top of the reconstruction against the contract itself. A
  // mismatch means a log was missed, and a wrong holder table is worse than
  // an absent one, so nothing is stored in that case.
  let verified = true;
  for (const [addr, computed] of holders.slice(0, 5)) {
    const onchain = await balanceOf(row.address, addr);
    if (onchain == null) continue;
    if (onchain !== computed) {
      verified = false;
      break;
    }
  }

  const complete = scannedTo >= head;
  if (!verified) {
    await prisma.indexerCursor.upsert({
      where: { key: cursorKey },
      create: { key: cursorKey, lastBlock: 0n, lastAt: new Date(), metaJson: JSON.stringify({ error: "balance_mismatch" }) },
      update: { lastBlock: 0n, lastAt: new Date(), metaJson: JSON.stringify({ error: "balance_mismatch" }) },
    });
    return { address: row.address, skipped: "balance_mismatch" };
  }

  const supply = (() => {
    try {
      return row.totalSupply ? BigInt(row.totalSupply) : null;
    } catch {
      return null;
    }
  })();
  const pctOf = (v: bigint) =>
    supply && supply > 0n ? Number((v * 100_000_000n) / supply) / 1_000_000 : null;

  const creator =
    row.deployer ?? (deployBlock != null ? await findCreator(row.address, deployBlock) : null);

  await prisma.$transaction(async (tx) => {
    await tx.tokenHolder.deleteMany({ where: { tokenId: row.id } });
    if (holders.length) {
      await tx.tokenHolder.createMany({
        data: holders.slice(0, 500).map(([address, balance]) => ({
          tokenId: row.id,
          address,
          balance: balance.toString(),
          pct: pctOf(balance),
          isContract: null,
          labelsJson: JSON.stringify(
            [
              creator && address === creator ? "deployer" : null,
              shouldIgnoreForOwnership(address, OBSERVED_ARC_CHAIN) ? "known_service" : null,
            ].filter(Boolean)
          ),
        })),
      });
    }
    await tx.token.update({
      where: { id: row.id },
      data: {
        holderCount: holders.length,
        deployer: creator ?? row.deployer,
        deployBlock: deployBlock != null ? BigInt(deployBlock) : row.deployBlock,
      },
    });
  });

  await prisma.indexerCursor.upsert({
    where: { key: cursorKey },
    create: {
      key: cursorKey,
      lastBlock: BigInt(scannedTo),
      lastAt: new Date(),
      metaJson: JSON.stringify({ holders: holders.length, complete }),
    },
    update: {
      lastBlock: BigInt(scannedTo),
      lastAt: new Date(),
      metaJson: JSON.stringify({ holders: holders.length, complete }),
    },
  });

  return { address: row.address, holders: holders.length, logs: logCount, complete };
}

export async function runObservedArcHolderIndexer() {
  const head = Number(await rpc<string>("eth_blockNumber", []));
  if (!Number.isFinite(head) || head <= 0) throw new Error("Observed Arc RPC returned no head block");

  // Oldest refresh first, so no token is starved.
  const tokens = await prisma.token.findMany({
    where: { chain: OBSERVED_ARC_CHAIN },
    orderBy: [{ updatedAt: "asc" }],
    take: TOKENS_PER_RUN,
    select: { id: true, address: true, deployBlock: true, totalSupply: true, deployer: true },
  });

  const results: unknown[] = [];
  for (const token of tokens) {
    try {
      results.push(await indexToken(token, head));
    } catch (e) {
      results.push({ address: token.address, error: e instanceof Error ? e.message : String(e) });
    }
  }

  const failed = results.filter((r) => (r as { error?: string }).error).length;
  await prisma.dataSourceHealth.upsert({
    where: { key: "observed_arc_holders" },
    create: {
      key: "observed_arc_holders",
      name: "Observed Arc holder index (RPC)",
      healthy: failed < tokens.length,
      lastSuccessAt: new Date(),
      lastBlock: BigInt(head),
      metaJson: JSON.stringify({ processed: tokens.length, failed }),
    },
    update: {
      healthy: failed < tokens.length,
      lastSuccessAt: new Date(),
      lastBlock: BigInt(head),
      lastError: failed ? `${failed} of ${tokens.length} tokens failed` : null,
      metaJson: JSON.stringify({ processed: tokens.length, failed }),
    },
  });

  return results;
}
