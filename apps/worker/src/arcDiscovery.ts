import { getArcClients, getCode, scanSelectors } from "@rugkiller/chain";
import { discoverRecentApexiPairs } from "@rugkiller/analysis";
import { prisma } from "@rugkiller/db";
import type { Address, Hex } from "viem";

/** Blocks read together. They are still processed, and committed, in order. */
const BLOCK_FETCH_BATCH = 12;

/**
 * Discover new ERC-20-like tokens on Arc.
 * Skips bare contract deploys that are not tokens (avoids "Unknown token" spam).
 */
export async function runArcDiscovery(): Promise<string[]> {
  const arc = getArcClients();
  const found: string[] = [];

  let latest: number | null = null;
  try {
    const b = await arc.explorer.getLatestBlock();
    latest = b?.number ?? null;
    // getLatestBlock() returns null instead of throwing when the explorer is
    // unreadable, so only a real head read may count as a success. Otherwise
    // the previous success timestamp has to stand so the gap stays visible.
    const headError = latest != null ? null : "Explorer did not return a latest block.";
    await prisma.dataSourceHealth.upsert({
      where: { key: "arc_explorer" },
      create: {
        key: "arc_explorer",
        name: "Arc Blockscout",
        healthy: latest != null,
        lastSuccessAt: latest != null ? new Date() : null,
        lastBlock: latest != null ? BigInt(latest) : null,
        lastError: headError,
      },
      update: {
        healthy: latest != null,
        lastSuccessAt: latest != null ? new Date() : undefined,
        lastBlock: latest != null ? BigInt(latest) : undefined,
        lastError: headError,
      },
    });
  } catch (e) {
    await prisma.dataSourceHealth.upsert({
      where: { key: "arc_explorer" },
      create: {
        key: "arc_explorer",
        name: "Arc Blockscout",
        healthy: false,
        lastError: e instanceof Error ? e.message : String(e),
      },
      update: {
        healthy: false,
        lastError: e instanceof Error ? e.message : String(e),
      },
    });
    throw e;
  }

  // Both scans below run entirely against the node, so an explorer outage must
  // not disable discovery on an RPC that is still answering. The arc_explorer
  // health row above stays the separate signal that the explorer is down.
  if (latest == null && arc.rpc) {
    try {
      const head = Number(await arc.rpc.getBlockNumber());
      if (Number.isFinite(head) && head > 0) latest = head;
    } catch (e) {
      console.warn("[arc-discovery] rpc head", e instanceof Error ? e.message : e);
    }
  }

  const cursor = await prisma.indexerCursor.upsert({
    where: { key: "arc_token_discovery" },
    create: { key: "arc_token_discovery", lastBlock: BigInt(0) },
    update: {},
  });
  const dexCursor = await prisma.indexerCursor.upsert({
    where: { key: "arc_apexiswap_pairs" },
    create: { key: "arc_apexiswap_pairs", lastBlock: BigInt(0) },
    update: {},
  });

  // Verified APEXISWAP factory events are the strongest discovery signal for
  // tokens that have actually reached a WUSDC market. Chunking avoids public
  // RPC log-range limits; the first run intentionally backfills a bounded window.
  if (arc.rpc && latest != null) {
    const dexFrom = Number(dexCursor.lastBlock) > 0
      ? BigInt(Number(dexCursor.lastBlock) + 1)
      : BigInt(Math.max(0, latest - 8_000));
    try {
      const pairs = await discoverRecentApexiPairs(arc.rpc, dexFrom, BigInt(latest));
      for (const item of pairs) {
        const address = item.token.toLowerCase();
        const existing = await prisma.token.findUnique({
          where: { chain_address: { chain: "arc_testnet", address } },
        });
        if (!existing) {
          await prisma.token.create({
            data: {
              chain: "arc_testnet",
              address,
              standard: "ERC-20",
              rawMeta: JSON.stringify({
                discoveredBy: "apexiswap_pair_created",
                pair: item.pair,
                transactionHash: item.transactionHash,
                blockNumber: item.blockNumber.toString(),
              }),
            },
          });
        }
        if (!existing?.analysisUpdatedAt) found.push(address);
      }
      await prisma.indexerCursor.update({
        where: { key: "arc_apexiswap_pairs" },
        data: { lastBlock: BigInt(latest), lastAt: new Date() },
      });
    } catch (e) {
      console.warn("[arc-discovery] APEXISWAP logs", e instanceof Error ? e.message : e);
    }
  }

  // 1) Explorer ERC-20 inventory. Walk every Blockscout page so a fresh
  // production database can rebuild the complete historical token list. Once
  // caught up, refresh the first page every poll and the full inventory every
  // 15 minutes to avoid unnecessary explorer and database load.
  try {
    const inventoryHealth = await prisma.dataSourceHealth.findUnique({
      where: { key: "arc_testnet_tokens" },
    });
    let previousIndexed = 0;
    try {
      previousIndexed = Number(JSON.parse(inventoryHealth?.metaJson ?? "{}").indexed ?? 0);
    } catch {
      previousIndexed = 0;
    }
    const runFullInventory = previousIndexed <= 0 || !inventoryHealth?.lastSuccessAt
      || Date.now() - inventoryHealth.lastSuccessAt.getTime() >= 15 * 60 * 1000;
    let inventoryCursor: Record<string, unknown> | null = null;
    let inventoryPages = 0;
    let inventoryIndexed = 0;
    let inventoryRows = 0;
    do {
      const tokens = await arc.explorer.getTokens({ type: "ERC-20", cursor: inventoryCursor });
      inventoryRows += (tokens.items ?? []).length;
      const candidates = (tokens.items ?? []).flatMap((t) => {
        const address = (t.address ?? t.address_hash ?? "").toLowerCase();
        const name = t.name?.trim() || null;
        const symbol = t.symbol?.trim() || null;
        if (!address.startsWith("0x") || address.length !== 42 || (!name && !symbol && !t.total_supply)) return [];
        return [{
          address,
          name,
          symbol,
          decimals: t.decimals != null ? Number(t.decimals) : null,
          totalSupply: t.total_supply ?? null,
          holderCount: (t.holders ?? t.holders_count) != null ? Number(t.holders ?? t.holders_count) : null,
        }];
      });
      const existingRows = candidates.length ? await prisma.token.findMany({
        where: { chain: "arc_testnet", address: { in: candidates.map((item) => item.address) } },
      }) : [];
      const existingByAddress = new Map(existingRows.map((row) => [row.address, row]));
      const newRows = candidates.filter((item) => !existingByAddress.has(item.address));
      if (newRows.length) {
        await prisma.token.createMany({
          data: newRows.map((item) => ({ ...item, chain: "arc_testnet", standard: "ERC-20" })),
        });
      }
      const refreshes: Promise<unknown>[] = [];
      for (const item of candidates) {
        const existing = existingByAddress.get(item.address);
        if (found.length < 50 && (!existing || !existing.analysisUpdatedAt)) found.push(item.address);
        if (!existing) continue;
        // Identity is backfilled only when missing, so a correction is not
        // overwritten. Holder count and supply are live figures: gating them on
        // a missing name froze both at whatever the first sighting reported,
        // and holderCount is displayed and is the backfill's ranking key.
        const patch: Record<string, unknown> = {};
        if (!existing.name && item.name) patch.name = item.name;
        if (!existing.symbol && item.symbol) patch.symbol = item.symbol;
        if (existing.decimals == null && item.decimals != null) patch.decimals = item.decimals;
        if (existing.standard !== "ERC-20") patch.standard = "ERC-20";
        if (item.totalSupply != null && item.totalSupply !== existing.totalSupply) {
          patch.totalSupply = item.totalSupply;
        }
        if (item.holderCount != null && item.holderCount !== existing.holderCount) {
          patch.holderCount = item.holderCount;
        }
        // A row the explorer agrees with must not become a write.
        if (Object.keys(patch).length) {
          refreshes.push(prisma.token.update({ where: { id: existing.id }, data: patch }));
        }
      }
      if (refreshes.length) await Promise.all(refreshes);
      inventoryIndexed += candidates.length;
      inventoryCursor = tokens.next_page_params ?? null;
      inventoryPages++;
    } while (runFullInventory && inventoryCursor && inventoryPages < 100);

    // getTokens() throws on an HTTP failure and the catch below records the real
    // error, so this check is not standing in for a swallowed one: it only
    // separates a genuinely empty explorer response from a populated one, which
    // is still a gap rather than an inventory that contains zero tokens.
    const inventoryOk = inventoryRows > 0;
    const inventoryError = inventoryOk
      ? null
      : "Explorer returned no token rows; inventory treated as unavailable.";
    if (runFullInventory) await prisma.dataSourceHealth.upsert({
      where: { key: "arc_testnet_tokens" },
      create: {
        key: "arc_testnet_tokens",
        name: "Arc Testnet token inventory",
        healthy: inventoryOk,
        lastSuccessAt: inventoryOk ? new Date() : null,
        lastError: inventoryError,
        metaJson: JSON.stringify({ indexed: inventoryIndexed, pages: inventoryPages }),
      },
      update: {
        healthy: inventoryOk,
        lastSuccessAt: inventoryOk ? new Date() : undefined,
        lastError: inventoryError,
        metaJson: JSON.stringify({ indexed: inventoryIndexed, pages: inventoryPages }),
      },
    });
  } catch (e) {
    await prisma.dataSourceHealth.upsert({
      where: { key: "arc_testnet_tokens" },
      create: {
        key: "arc_testnet_tokens",
        name: "Arc Testnet token inventory",
        healthy: false,
        lastError: e instanceof Error ? e.message : String(e),
      },
      update: {
        healthy: false,
        lastError: e instanceof Error ? e.message : String(e),
      },
    });
    console.warn("[arc-discovery] tokens list", e instanceof Error ? e.message : e);
  }

    // 2) Recent contract creations. Include only ERC-20-like bytecode and optional explorer token info.
  if (arc.rpc && latest != null) {
    const from =
      Number(cursor.lastBlock) > 0 ? Number(cursor.lastBlock) + 1 : Math.max(0, latest - 20);
    const to = latest;
    const perPoll = Number(process.env.ARC_DISCOVERY_MAX_BLOCKS ?? 500);
    const maxBlocks = Number.isFinite(perPoll) && perPoll >= 1 ? Math.floor(perPoll) : 500;
    const end = Math.min(to, from + maxBlocks - 1);

    // The cursor may only advance over blocks that were scanned end to end.
    // Committing `end` after a break or an RPC error skipped those blocks for good.
    let lastScanned = from - 1;
    const rpcClient = arc.rpc;
    let stopped = false;

    for (let batchStart = from; batchStart <= end && !stopped; batchStart += BLOCK_FETCH_BATCH) {
      const batchEnd = Math.min(end, batchStart + BLOCK_FETCH_BATCH - 1);
      const numbers: number[] = [];
      for (let bn = batchStart; bn <= batchEnd; bn++) numbers.push(bn);
      // Block reads are independent, so issuing them together changes only the
      // wall clock. They are still walked in order below and the cursor still
      // advances over a contiguous prefix, which a break must not violate.
      const fetched = await Promise.all(
        numbers.map(async (bn) => {
          try {
            return {
              bn,
              block: await rpcClient.getBlock({ blockNumber: BigInt(bn), includeTransactions: true }),
            };
          } catch (e) {
            console.warn(`[arc-discovery] block ${bn}`, e instanceof Error ? e.message : e);
            return { bn, block: null };
          }
        })
      );

      for (const { bn, block } of fetched) {
        if (!block) {
          stopped = true;
          break;
        }
        let blockComplete = true;

        for (const tx of block.transactions ?? []) {
          if (typeof tx === "string") continue;
          if (tx.to != null || !tx.hash) continue;

          try {
            const receipt = await rpcClient.getTransactionReceipt({ hash: tx.hash });
            const created = receipt?.contractAddress?.toLowerCase();
            if (!created) continue;

            const code = await getCode(rpcClient, created as Address);
            if (!code || code === "0x" || code.length < 20) continue;

            // Must look like ERC-20 (transfer + balanceOf or totalSupply selectors)
            const sels = scanSelectors(code as Hex).map((s) => s.selector);
            const looksErc20 =
              sels.includes("a9059cbb") || // transfer
              sels.includes("70a08231") || // balanceOf
              sels.includes("18160ddd"); // totalSupply
            if (!looksErc20) continue;

            let name: string | null = null;
            let symbol: string | null = null;
            let decimals: number | null = null;
            let totalSupply: string | null = null;
            let holders: number | null = null;

            try {
              const token = await arc.explorer.getToken(created);
              if (token) {
                name = token.name?.trim() || null;
                symbol = token.symbol?.trim() || null;
                decimals = token.decimals != null ? Number(token.decimals) : null;
                totalSupply = token.total_supply ?? null;
                holders = token.holders != null ? Number(token.holders) : null;
              }
            } catch {
              /* optional */
            }

            const existing = await prisma.token.findUnique({
              where: { chain_address: { chain: "arc_testnet", address: created } },
            });

            if (!existing) {
              await prisma.token.create({
                data: {
                  chain: "arc_testnet",
                  address: created,
                  name,
                  symbol,
                  decimals,
                  totalSupply,
                  standard: "ERC-20",
                  holderCount: holders,
                  deployer: tx.from?.toLowerCase() ?? null,
                  deployTxHash: tx.hash,
                  deployBlock: BigInt(bn),
                  deployTimestamp: block.timestamp
                    ? new Date(Number(block.timestamp) * 1000)
                    : null,
                },
              });
              found.push(created);
            } else if (!existing.analysisUpdatedAt) {
              found.push(created);
            }
          } catch (e) {
            // A creation we could not read leaves this block incomplete, so it
            // has to be rescanned rather than skipped.
            console.warn(`[arc-discovery] tx ${tx.hash}`, e instanceof Error ? e.message : e);
            blockComplete = false;
          }
        }

        if (!blockComplete) {
          stopped = true;
          break;
        }
        lastScanned = bn;
      }
    }

    if (lastScanned >= from) {
      await prisma.indexerCursor.update({
        where: { key: "arc_token_discovery" },
        data: { lastBlock: BigInt(lastScanned), lastAt: new Date() },
      });
    }
  }

  if (found.length) {
    console.log(`[arc-discovery] token candidates: ${found.length}`);
  }
  return [...new Set(found)];
}
