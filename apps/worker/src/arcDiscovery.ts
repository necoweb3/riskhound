import { getArcClients, getCode, scanSelectors } from "@rugkiller/chain";
import { discoverRecentApexiPairs } from "@rugkiller/analysis";
import { prisma } from "@rugkiller/db";
import type { Address, Hex } from "viem";

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
    await prisma.dataSourceHealth.upsert({
      where: { key: "arc_explorer" },
      create: {
        key: "arc_explorer",
        name: "Arc Blockscout",
        healthy: latest != null,
        lastSuccessAt: new Date(),
        lastBlock: latest != null ? BigInt(latest) : null,
      },
      update: {
        healthy: latest != null,
        lastSuccessAt: new Date(),
        lastBlock: latest != null ? BigInt(latest) : undefined,
        lastError: null,
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
    const runFullInventory = !inventoryHealth?.lastSuccessAt
      || Date.now() - inventoryHealth.lastSuccessAt.getTime() >= 15 * 60 * 1000;
    let inventoryCursor: Record<string, unknown> | null = null;
    let inventoryPages = 0;
    let inventoryIndexed = 0;
    do {
      const tokens = await arc.explorer.getTokens({ type: "ERC-20", cursor: inventoryCursor });
      for (const t of tokens.items ?? []) {
      const address = (t.address ?? t.address_hash ?? "").toLowerCase();
      if (!address.startsWith("0x") || address.length !== 42) continue;

      const name = t.name?.trim() || null;
      const symbol = t.symbol?.trim() || null;
      // Skip empty metadata placeholders
      if (!name && !symbol && !t.total_supply) continue;

      const existing = await prisma.token.findUnique({
        where: { chain_address: { chain: "arc_testnet", address } },
      });

      if (!existing) {
        await prisma.token.create({
          data: {
            chain: "arc_testnet",
            address,
            name,
            symbol,
            decimals: t.decimals != null ? Number(t.decimals) : null,
            totalSupply: t.total_supply ?? null,
            standard: "ERC-20",
            holderCount: (t.holders ?? t.holders_count) != null ? Number(t.holders ?? t.holders_count) : null,
          },
        });
        if (found.length < 50) found.push(address);
      } else {
        // Enrich missing metadata
        if ((!existing.name && name) || (!existing.symbol && symbol)) {
          await prisma.token.update({
            where: { id: existing.id },
            data: {
              name: existing.name ?? name,
              symbol: existing.symbol ?? symbol,
              decimals: existing.decimals ?? (t.decimals != null ? Number(t.decimals) : null),
              totalSupply: existing.totalSupply ?? t.total_supply ?? null,
              standard: "ERC-20",
              holderCount: (t.holders ?? t.holders_count) != null ? Number(t.holders ?? t.holders_count) : existing.holderCount,
            },
          });
        }
        if (!existing.analysisUpdatedAt && found.length < 50) found.push(address);
      }
      inventoryIndexed++;
    }
      inventoryCursor = tokens.next_page_params ?? null;
      inventoryPages++;
    } while (runFullInventory && inventoryCursor && inventoryPages < 100);

    if (runFullInventory) await prisma.dataSourceHealth.upsert({
      where: { key: "arc_testnet_tokens" },
      create: {
        key: "arc_testnet_tokens",
        name: "Arc Testnet token inventory",
        healthy: true,
        lastSuccessAt: new Date(),
        metaJson: JSON.stringify({ indexed: inventoryIndexed, pages: inventoryPages }),
      },
      update: {
        healthy: true,
        lastSuccessAt: new Date(),
        lastError: null,
        metaJson: JSON.stringify({ indexed: inventoryIndexed, pages: inventoryPages }),
      },
    });
  } catch (e) {
    console.warn("[arc-discovery] tokens list", e instanceof Error ? e.message : e);
  }

    // 2) Recent contract creations. Include only ERC-20-like bytecode and optional explorer token info.
  if (arc.rpc && latest != null) {
    const from =
      Number(cursor.lastBlock) > 0 ? Number(cursor.lastBlock) + 1 : Math.max(0, latest - 20);
    const to = latest;
    const end = Math.min(to, from + 12);

    for (let bn = from; bn <= end; bn++) {
      try {
        const block = await arc.rpc.getBlock({
          blockNumber: BigInt(bn),
          includeTransactions: true,
        });
        if (!block?.transactions) continue;

        for (const tx of block.transactions) {
          if (typeof tx === "string") continue;
          if (tx.to != null || !tx.hash) continue;

          try {
            const receipt = await arc.rpc.getTransactionReceipt({ hash: tx.hash });
            const created = receipt?.contractAddress?.toLowerCase();
            if (!created) continue;

            const code = await getCode(arc.rpc, created as Address);
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
          } catch {
            /* skip tx */
          }
        }
      } catch (e) {
        console.warn(`[arc-discovery] block ${bn}`, e instanceof Error ? e.message : e);
        break;
      }
    }

    await prisma.indexerCursor.update({
      where: { key: "arc_token_discovery" },
      data: { lastBlock: BigInt(end), lastAt: new Date() },
    });
  } else if (latest != null) {
    await prisma.indexerCursor.update({
      where: { key: "arc_token_discovery" },
      data: { lastBlock: BigInt(latest), lastAt: new Date() },
    });
  }

  if (found.length) {
    console.log(`[arc-discovery] token candidates: ${found.length}`);
  }
  return [...new Set(found)];
}
