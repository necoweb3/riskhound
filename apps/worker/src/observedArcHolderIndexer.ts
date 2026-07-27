import { prisma } from "@rugkiller/db";
import { OBSERVED_ARC_CHAIN, shouldIgnoreForOwnership } from "@rugkiller/shared";

/**
 * Chain 5042 has no public explorer, so holder distribution and the creator
 * address used to be unavailable there. Both are recoverable from the node:
 * ERC-20 balances are the running sum of Transfer events, and the creator is
 * the sender of the transaction that produced the contract.
 *
 * balanceOf reads the latest block, so the reconstruction can only be checked
 * against it once the scan has caught up to head. Until then the fold is kept
 * as scan state and no holder count is published, so a missed log surfaces as
 * a mismatch or as a gap rather than as a confident wrong number.
 */

const RPC = () => process.env.OBSERVED_ARC_RPC_URL ?? "https://5042.rpc.thirdweb.com";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO = "0x0000000000000000000000000000000000000000";

/** An empty or unparsable env value must not turn a bound into 0 or NaN. */
function positiveEnv(raw: string | undefined, fallback: number) {
  const parsed = Math.floor(Number(raw));
  return raw?.trim() && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** The provider caps a log query at 1000 blocks regardless of result size. */
const MAX_LOG_RANGE = 1000;
/** Bound the work a single tick may do, so one huge token cannot stall the loop. */
const MAX_RANGE_PER_RUN = 300_000;
const TOKENS_PER_RUN = positiveEnv(process.env.OBSERVED_ARC_HOLDER_BATCH, 3);
/** How many candidates to re-read from the contract when the fold disagrees. */
const BALANCE_OF_FALLBACK_LIMIT = positiveEnv(process.env.OBSERVED_ARC_BALANCEOF_LIMIT, 60);
/**
 * Log windows are independent sums, so they can be in flight together. Kept
 * modest because the default endpoint is keyless and rate-limits per client.
 */
const LOG_CONCURRENCY = positiveEnv(process.env.OBSERVED_ARC_LOG_CONCURRENCY, 6);
/** A 429 or a 5xx says nothing about the request, so it is worth repeating. */
const RPC_ATTEMPTS = positiveEnv(process.env.OBSERVED_ARC_RPC_ATTEMPTS, 3);
/** Rows written per statement, so a large holder set cannot blow the statement. */
const HOLDER_WRITE_CHUNK = 2_000;
const CURSOR_PREFIX = "observed_arc_holders:";

type Log = { topics: string[]; data: string; blockNumber: string; transactionHash: string };

type CursorMeta = {
  holders?: number;
  complete?: boolean;
  source?: "transfer_logs" | "balance_of";
  /**
   * False when the stored rows are a sample rather than the whole balance set.
   * Folding a new scan onto a sample invents balances for every address the
   * sample left out, so such a run has to start again from the deploy block.
   */
  holdersComplete?: boolean;
  /** findCreator cannot recover a factory deploy, so stop paying for it. */
  creatorUnknown?: boolean;
  error?: string;
};

let rpcId = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function rpc<T>(method: string, params: unknown[], timeoutMs = 20_000): Promise<T> {
  let transient: Error | null = null;
  for (let attempt = 1; attempt <= RPC_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(300 * 2 ** (attempt - 2));
    const res = await fetch(RPC(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
    // A timeout or a dropped connection says nothing about the request itself.
    if (res instanceof Error) {
      transient = res;
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      transient = new Error(`${method}: HTTP ${res.status}`);
      continue;
    }
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { message?: string } };
    // A JSON-RPC error is the node's considered answer. Repeating it only burns
    // the rate limit that the retries above exist to protect.
    if (body.error) throw new Error(`${method}: ${body.error.message ?? "rpc error"}`);
    return body.result as T;
  }
  throw transient ?? new Error(`${method}: no response`);
}

const hex = (n: number) => `0x${n.toString(16)}`;
const addrFromTopic = (topic: string) => `0x${topic.slice(26)}`.toLowerCase();

async function hasCodeAt(address: string, block: number) {
  const code = await rpc<string>("eth_getCode", [address, hex(block)]);
  return Boolean(code) && code !== "0x";
}

/**
 * A node without archive state answers a historical eth_getCode with an error
 * rather than an empty result. That is a missing capability of the endpoint,
 * not a failure of this token, so report it as unknown and let the caller skip.
 */
async function hasCodeAtHistorical(address: string, block: number): Promise<boolean | null> {
  return hasCodeAt(address, block).catch(() => null);
}

/**
 * First block at which the contract has bytecode. Needs an archive node; if
 * historical state is unavailable every probe answers the same way, or answers
 * with an error, and the search returns null, which the caller treats as
 * unknown rather than as block 0.
 */
async function findDeployBlock(address: string, head: number): Promise<number | null> {
  if (!(await hasCodeAt(address, head))) return null;
  const atGenesis = await hasCodeAtHistorical(address, 1);
  if (atGenesis == null || atGenesis) return null; // archive not available, or genesis
  let lo = 1;
  let hi = head;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const present = await hasCodeAtHistorical(address, mid);
    if (present == null) return null;
    if (present) hi = mid;
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
  const windows: [number, number][] = [];
  for (let from = fromBlock; from <= toBlock; from += MAX_LOG_RANGE) {
    windows.push([from, Math.min(from + MAX_LOG_RANGE - 1, toBlock)]);
  }

  // Each window is an independent sum, so running several at once changes the
  // wall clock and nothing else. The first failure stops the pool: every window
  // after a gap is unusable anyway.
  const pages: (Log[] | null)[] = new Array(windows.length).fill(null);
  let failure: string | null = null;
  let next = 0;
  const fetchWindows = async () => {
    for (;;) {
      const index = next++;
      if (index >= windows.length || failure) return;
      const [from, to] = windows[index];
      try {
        pages[index] = await rpc<Log[]>("eth_getLogs", [
          { address: token, topics: [TRANSFER], fromBlock: hex(from), toBlock: hex(to) },
        ]);
      } catch (e) {
        failure ??= e instanceof Error ? e.message : String(e);
        return;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(LOG_CONCURRENCY, windows.length) }, fetchWindows)
  );

  const deltas = new Map<string, bigint>();
  const bump = (a: string, v: bigint) => deltas.set(a, (deltas.get(a) ?? 0n) + v);
  let logCount = 0;
  // Only the contiguous prefix that read cleanly may be committed. Folding a
  // window from after a gap produces balances no chain read supports, and
  // discarding the prefix as well means a rate-limited run makes no progress.
  let scannedTo = fromBlock - 1;

  for (let index = 0; index < windows.length; index++) {
    const logs = pages[index];
    if (!logs) break;
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
    scannedTo = windows[index][1];
  }

  return { deltas, logCount, scannedTo, scanError: scannedTo < toBlock ? failure : null };
}

/**
 * Apply a scan's deltas to the balances carried over from earlier scans.
 *
 * `carryOver` must be empty when the scan started at the deploy block, because
 * such a scan already contains the whole history. Folding it onto stored
 * balances counts every transfer twice, which is what previously made a
 * mismatched token unable to recover.
 */
export function foldBalances(
  carryOver: Iterable<[string, bigint]>,
  deltas: Iterable<[string, bigint]>
): Map<string, bigint> {
  const balances = new Map<string, bigint>(carryOver);
  for (const [addr, delta] of deltas) {
    balances.set(addr, (balances.get(addr) ?? 0n) + delta);
  }
  // The zero address is the mint and burn counterparty, not a holder.
  balances.delete(ZERO);
  return balances;
}

/** Positive balances, largest first. A stable order for equal balances. */
export function rankHolders(balances: Map<string, bigint>): [string, bigint][] {
  return [...balances.entries()]
    .filter(([, v]) => v > 0n)
    .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : a[0] < b[0] ? -1 : 1));
}

/**
 * Least recently attempted first, with a never-attempted token ahead of every
 * attempted one. Ordering on Token.updatedAt instead, which only the success
 * path writes, kept re-selecting the same tokens whenever they skipped.
 */
export function orderByAttempt<T extends { address: string }>(
  tokens: T[],
  attemptedAt: Map<string, number>
): T[] {
  return [...tokens].sort((a, b) => {
    const left = attemptedAt.get(a.address) ?? 0;
    const right = attemptedAt.get(b.address) ?? 0;
    return left !== right ? left - right : a.address < b.address ? -1 : 1;
  });
}

/**
 * A run is a clean pass only if it moved at least one token forward. Skips are
 * not errors, so counting errors alone published an all-skipped run as healthy
 * with a fresh success timestamp over zero holder rows.
 */
export function isCleanRun(counts: {
  considered: number;
  failed: number;
  indexed: number;
  upToDate: number;
}): boolean {
  if (counts.considered <= 0) return false;
  if (counts.failed >= counts.considered) return false;
  return counts.indexed + counts.upToDate > 0;
}

function parseMeta(raw: string | null | undefined): CursorMeta {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as CursorMeta;
  } catch {
    return {};
  }
}

/**
 * The batch is ordered by this row, so it has to move on every outcome and not
 * only on success. Ordering on Token.updatedAt, which only the success path
 * writes, let a token that always skips hold the head of the queue forever.
 */
async function writeCursor(key: string, meta: CursorMeta, lastBlock?: bigint) {
  const metaJson = JSON.stringify(meta);
  await prisma.indexerCursor.upsert({
    where: { key },
    create: { key, lastBlock: lastBlock ?? 0n, lastAt: new Date(), metaJson },
    update: { ...(lastBlock != null ? { lastBlock } : {}), lastAt: new Date(), metaJson },
  });
}

/** Record a thrown run without losing what the previous run learned. */
async function markCursorError(address: string, message: string) {
  const key = `${CURSOR_PREFIX}${address}`;
  const existing = await prisma.indexerCursor.findUnique({
    where: { key },
    select: { metaJson: true },
  });
  await writeCursor(key, { ...parseMeta(existing?.metaJson), error: message.slice(0, 200) });
}

type IndexOutcome =
  | { address: string; skipped: string }
  | { address: string; error: string }
  | {
      address: string;
      holders: number;
      logs: number;
      complete: boolean;
      source: string;
      scanError: string | null;
    };

async function indexToken(row: {
  id: string;
  address: string;
  deployBlock: bigint | null;
  totalSupply: string | null;
  deployer: string | null;
}, head: number): Promise<IndexOutcome> {
  const cursorKey = `${CURSOR_PREFIX}${row.address}`;
  const cursor = await prisma.indexerCursor.findUnique({ where: { key: cursorKey } });
  const meta = parseMeta(cursor?.metaJson);
  const lastScanned = cursor ? Number(cursor.lastBlock) : 0;
  // Stored rows may only be carried forward when they are the whole balance
  // set; the balance_of fallback stores a top-N sample of it.
  const resumable = lastScanned > 0 && meta.holdersComplete !== false;

  let deployBlock = row.deployBlock != null ? Number(row.deployBlock) : null;
  if (!resumable && deployBlock == null) {
    deployBlock = await findDeployBlock(row.address, head);
    if (deployBlock == null) {
      await writeCursor(cursorKey, { ...meta, error: "deploy_block_unknown" });
      return { address: row.address, skipped: "deploy_block_unknown" };
    }
    // The binary search costs ~log2(head) eth_getCode calls. Storing the answer
    // now means a later skip or failure does not pay for it all over again.
    await prisma.token.update({
      where: { id: row.id },
      data: { deployBlock: BigInt(deployBlock) },
    });
  }

  const from = resumable ? lastScanned + 1 : deployBlock!;
  if (from > head) {
    await writeCursor(cursorKey, { ...meta, error: undefined }, BigInt(lastScanned));
    return { address: row.address, skipped: "up_to_date" };
  }
  // Cap the window so a cold token cannot monopolise the tick.
  const to = Math.min(head, from + MAX_RANGE_PER_RUN - 1);

  const { deltas, logCount, scannedTo, scanError } = await scanTransfers(row.address, from, to);
  if (scannedTo < from) throw new Error(scanError ?? `eth_getLogs read no window ${from}-${to}`);

  // A scan that starts at the deploy block already covers the whole history,
  // so folding it onto stored balances would count every transfer twice. That
  // is what made a mismatched token stay mismatched forever: the reset cursor
  // forced a full rescan while its old rows were still there.
  const carryOver: [string, bigint][] = [];
  if (resumable) {
    const existing = await prisma.tokenHolder.findMany({
      where: { tokenId: row.id },
      select: { address: true, balance: true },
    });
    for (const h of existing) {
      try {
        carryOver.push([h.address, BigInt(h.balance)]);
      } catch {
        /* a corrupt row is rebuilt from the deltas */
      }
    }
  }

  let holders = rankHolders(foldBalances(carryOver, deltas));

  const complete = scannedTo >= head;
  let source: "transfer_logs" | "balance_of" = "transfer_logs";
  // Whether the rows about to be written are the entire balance set.
  let holdersComplete = true;

  // balanceOf reads "latest", so it describes the same state as the fold only
  // once the scan has reached the head block. Comparing a capped scan against
  // it reported every long-history token as mismatched forever.
  let verified = true;
  let answered = 0;
  if (complete) {
    for (const [addr, computed] of holders.slice(0, 5)) {
      const onchain = await balanceOf(row.address, addr);
      if (onchain == null) continue;
      answered++;
      if (onchain !== computed) {
        verified = false;
        break;
      }
    }
    // Five silent nulls are an unread contract, not a passed check, and a fold
    // nothing confirmed must not be published as a verified holder set.
    if (verified && holders.length > 0 && answered === 0) {
      await writeCursor(
        cursorKey,
        { ...meta, error: "verification_unavailable" },
        BigInt(lastScanned)
      );
      return { address: row.address, skipped: "verification_unavailable" };
    }
  }

  if (!verified) {
    // Summing Transfer values does not describe every token: a fee-on-transfer
    // or rebasing contract moves balances without a matching event, so the
    // sum is legitimately wrong. The address set from the logs is still right,
    // and balanceOf is authoritative, so ask the contract instead of throwing
    // the whole token away.
    const candidates = holders.slice(0, BALANCE_OF_FALLBACK_LIMIT).map(([addr]) => addr);
    const authoritative: [string, bigint][] = [];
    let unreadable = 0;
    for (const addr of candidates) {
      const onchain = await balanceOf(row.address, addr);
      if (onchain == null) {
        unreadable++;
        continue;
      }
      if (onchain > 0n) authoritative.push([addr, onchain]);
    }
    // If the contract would not answer either, we know nothing. Storing a
    // partial read as the holder set would understate concentration.
    if (unreadable > candidates.length / 4) {
      await writeCursor(cursorKey, { ...meta, error: "balance_unreadable" }, 0n);
      return { address: row.address, skipped: "balance_unreadable" };
    }
    holders = authoritative.sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));
    source = "balance_of";
    // These are the top BALANCE_OF_FALLBACK_LIMIT addresses re-read from the
    // contract, not the whole holder set. They are true balances but they are
    // not a holder count, and they cannot be the base of the next fold.
    holdersComplete = false;
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

  let creator = row.deployer;
  let creatorUnknown = meta.creatorUnknown === true;
  if (!creator && deployBlock != null && !creatorUnknown) {
    creator = await findCreator(row.address, deployBlock);
    // A factory or CREATE2 deploy has no top-level creation tx to match, so the
    // same block and its receipts would be re-read every tick for the same null.
    creatorUnknown = creator == null;
  }

  await prisma.$transaction(
    async (tx) => {
      await tx.tokenHolder.deleteMany({ where: { tokenId: row.id } });
      // The whole reconstructed set is stored, not a leading slice of it: the
      // rows are reloaded as the prior balance state, so anything dropped here
      // is folded onto zero on the next tick and silently loses its balance.
      for (let i = 0; i < holders.length; i += HOLDER_WRITE_CHUNK) {
        await tx.tokenHolder.createMany({
          data: holders.slice(i, i + HOLDER_WRITE_CHUNK).map(([address, balance]) => ({
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
          // holderCount is served as an onchain figure, so it may only come
          // from a fold that reached head and that balanceOf agreed with. A
          // capped backfill window and the top-N balance_of sample are both
          // partial views of the holder set, and neither is that figure.
          ...(complete && holdersComplete ? { holderCount: holders.length } : {}),
          deployer: creator,
          deployBlock: deployBlock != null ? BigInt(deployBlock) : row.deployBlock,
        },
      });
    },
    { timeout: 60_000 }
  );

  await writeCursor(
    cursorKey,
    {
      holders: holders.length,
      complete,
      source,
      holdersComplete,
      creatorUnknown,
      ...(scanError ? { error: scanError } : {}),
    },
    BigInt(scannedTo)
  );

  return { address: row.address, holders: holders.length, logs: logCount, complete, source, scanError };
}

export async function runObservedArcHolderIndexer() {
  const head = Number(await rpc<string>("eth_blockNumber", []));
  if (!Number.isFinite(head) || head <= 0) throw new Error("Observed Arc RPC returned no head block");

  // Least recently attempted first, so no token is starved. Token.updatedAt is
  // written only by the success path, so ordering on it kept re-selecting the
  // same three tokens whenever they skipped; the per-token cursor moves on
  // every outcome, including skips and errors.
  const inventory = await prisma.token.findMany({
    where: { chain: OBSERVED_ARC_CHAIN },
    select: { id: true, address: true, deployBlock: true, totalSupply: true, deployer: true },
  });
  const cursors = await prisma.indexerCursor.findMany({
    where: { key: { startsWith: CURSOR_PREFIX } },
    select: { key: true, lastAt: true },
  });
  const attemptedAt = new Map(
    cursors.map((c) => [c.key.slice(CURSOR_PREFIX.length), c.lastAt?.getTime() ?? 0])
  );
  const tokens = orderByAttempt(inventory, attemptedAt).slice(0, TOKENS_PER_RUN);

  const results: IndexOutcome[] = [];
  for (const token of tokens) {
    try {
      results.push(await indexToken(token, head));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await markCursorError(token.address, message).catch(() => undefined);
      results.push({ address: token.address, error: message });
    }
  }

  const errors = results.filter((r): r is { address: string; error: string } => "error" in r);
  const skipped = results.filter((r): r is { address: string; skipped: string } => "skipped" in r);
  const indexed = results.filter((r) => "holders" in r);
  const failed = errors.length;
  // A token that had nothing new to scan is finished, not a gap. Every other
  // skip reason, and every scan cut short by the endpoint, is one.
  const upToDate = skipped.filter((s) => s.skipped === "up_to_date").length;
  const gaps = [
    ...new Set([
      ...skipped.filter((s) => s.skipped !== "up_to_date").map((s) => s.skipped),
      ...results.flatMap((r) => ("scanError" in r && r.scanError ? ["scan_incomplete"] : [])),
    ]),
  ];

  // A count alone cannot be acted on. "3 of 3 failed" told us nothing about
  // why, so the reasons are stored with it.
  const parts: string[] = [];
  if (tokens.length === 0) {
    parts.push("No observed Arc tokens are in the inventory, so nothing could be indexed.");
  }
  if (failed) {
    parts.push(
      `${failed} of ${tokens.length} tokens failed: ${errors
        .slice(0, 3)
        .map((e) => `${e.address.slice(0, 10)}: ${e.error.slice(0, 120)}`)
        .join(" | ")}`
    );
  }
  if (gaps.length) parts.push(`gaps: ${gaps.join(", ")}`);
  const summary = parts.length ? parts.join(" ") : null;

  const healthy = isCleanRun({
    considered: tokens.length,
    failed,
    indexed: indexed.length,
    upToDate,
  });

  await prisma.dataSourceHealth.upsert({
    where: { key: "observed_arc_holders" },
    create: {
      key: "observed_arc_holders",
      name: "Observed Arc holder index (RPC)",
      healthy,
      lastSuccessAt: healthy ? new Date() : null,
      lastBlock: BigInt(head),
      lastError: summary,
      metaJson: JSON.stringify({
        processed: tokens.length,
        indexed: indexed.length,
        failed,
        skipped: skipped.map((s) => s.skipped),
      }),
    },
    update: {
      healthy,
      // Only a run that indexed something may refresh the success timestamp.
      lastSuccessAt: healthy ? new Date() : undefined,
      lastBlock: BigInt(head),
      lastError: summary,
      metaJson: JSON.stringify({
        processed: tokens.length,
        indexed: indexed.length,
        failed,
        skipped: skipped.map((s) => s.skipped),
      }),
    },
  });

  return results;
}
