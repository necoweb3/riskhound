import { getRobinhoodClients } from "@rugkiller/chain";
import type { BsTokenInfo } from "@rugkiller/chain";
import { prisma, jstr } from "@rugkiller/db";
import type { EventClass } from "@rugkiller/shared";

export async function runRobinhoodIndexer() {
  const rh = getRobinhoodClients();

  let latest: number | null = null;
  try {
    const b = await rh.explorer.getLatestBlock();
    latest = b?.number ?? null;
    // getLatestBlock() returns null instead of throwing when the explorer is
    // unreadable, so only a real head read may refresh the success timestamp
    // or clear the previous error.
    const headError = latest != null ? null : "Explorer did not return a latest block.";
    await prisma.dataSourceHealth.upsert({
      where: { key: "rh_explorer" },
      create: {
        key: "rh_explorer",
        name: "Robinhood Blockscout",
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
      where: { key: "rh_explorer" },
      create: {
        key: "rh_explorer",
        name: "Robinhood Blockscout",
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

  let unreadCreators = 0;
  try {
    // Walk the explorer pages instead of the first slice of page one, so tokens
    // past the newest few are indexed at all. Bounded to keep one poll finite.
    const maxPagesEnv = Number(process.env.ROBINHOOD_INDEXER_MAX_PAGES ?? 5);
    const maxPages = Number.isFinite(maxPagesEnv) && maxPagesEnv >= 1 ? Math.floor(maxPagesEnv) : 5;
    const concurrencyEnv = Number(process.env.ROBINHOOD_INDEXER_CONCURRENCY ?? 8);
    const concurrency =
      Number.isFinite(concurrencyEnv) && concurrencyEnv >= 1 ? Math.floor(concurrencyEnv) : 8;
    const items: BsTokenInfo[] = [];
    let cursor: Record<string, unknown> | null = null;
    let pages = 0;
    do {
      const page = await rh.explorer.getTokens({ type: "ERC-20", cursor });
      items.push(...(page.items ?? []));
      cursor = page.next_page_params ?? null;
      pages++;
    } while (cursor && pages < maxPages);

    // Memoised for the length of the run. Both reads are keyed on an address,
    // not on the token, so a deployer behind ten of these tokens answered ten
    // identical explorer requests and ten identical event lookups per poll.
    const creations = new Map<string, ReturnType<typeof rh.explorer.getContractCreation>>();
    const deployerTxs = new Map<string, ReturnType<typeof rh.explorer.getAddressTransactions>>();
    const deployerWallets = new Map<string, Promise<unknown>>();
    const memo = <T>(cache: Map<string, T>, key: string, make: () => T): T => {
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const made = make();
      cache.set(key, made);
      return made;
    };

    let processed = 0;
    let creatorUnreadable = 0;

    const indexToken = async (t: BsTokenInfo) => {
      const address = (t.address ?? t.address_hash ?? "").toLowerCase();
      if (!address.startsWith("0x")) return;
      processed++;

      let deployer: string | null = null;
      let deployTx: string | null = null;
      // "We could not read the creator" and "the creator is clean" are
      // different facts, and the concentration signal below must not be
      // dropped just because this unrelated call failed.
      let creationUnread = false;
      try {
        const creation = await memo(creations, address, () => rh.explorer.getContractCreation(address));
        deployer = creation?.contractCreator?.toLowerCase() ?? null;
        deployTx = creation?.txHash ?? null;
      } catch {
        creationUnread = true;
        creatorUnreadable++;
      }

      if (deployer) {
        const known = deployer;
        await memo(deployerWallets, known, () =>
          prisma.wallet.upsert({
            where: { chain_address: { chain: "robinhood", address: known } },
            create: {
              chain: "robinhood",
              address: known,
              labelsJson: jstr(["deployer"]),
            },
            update: {},
          })
        );
      }

      try {
        const holders = await rh.explorer.getTokenHolders(address);
        const items = holders.items ?? [];
        if (items.length > 0 && t.total_supply) {
          const supply = BigInt(t.total_supply);
          if (supply > 0n) {
            let top = 0n;
            for (const h of items.slice(0, 5)) {
              top += BigInt(h.value ?? "0");
            }
            const pct = Number((top * 10000n) / supply) / 100;
            if (pct >= 90) {
              await upsertEvent({
                chain: "robinhood",
                eventClass: "heavy_insider_control",
                title: `High top-holder concentration on ${t.symbol ?? address.slice(0, 10)}`,
                detail:
                  `Top holders control ~${pct.toFixed(1)}% of supply (explorer snapshot).` +
                  (creationUnread
                    ? " The contract creator could not be read from the explorer for this snapshot."
                    : ""),
                tokenAddress: address,
                addresses: [
                  ...(deployer ? [deployer] : []),
                  ...items.slice(0, 5).map((h) =>
                    (typeof h.address === "string" ? h.address : h.address.hash).toLowerCase()
                  ),
                ],
                confidence: "medium",
                txHashes: deployTx ? [deployTx] : [],
                evidence: [
                  {
                    type: "contract",
                    chain: "robinhood",
                    value: address,
                    url: `https://robinhoodchain.blockscout.com/token/${address}`,
                  },
                ],
              });
            }
          }
        }
      } catch {
        /* optional */
      }

      if (deployer) {
        const known = deployer;
        try {
          const txs = await memo(deployerTxs, known, () => rh.explorer.getAddressTransactions(known));
          const deploys = (txs.items ?? []).filter((x) => x.created_contract?.hash);
          if (deploys.length >= 5) {
            await upsertEvent({
              chain: "robinhood",
              eventClass: "suspicious_rug_behavior",
              // upsertEvent dedupes on the title, so the creation count has to
              // live in the detail or every change of it creates a new event.
              title: "Serial contract deployer",
              detail:
                `${deploys.length} contract creations from same wallet on recent explorer page. Not proof of malice; flagged for correlation.`,
              tokenAddress: address,
              addresses: [deployer],
              confidence: "low",
              txHashes: deploys.slice(0, 5).map((x) => x.hash),
              evidence: deploys.slice(0, 5).map((x) => ({
                type: "tx" as const,
                chain: "robinhood",
                value: x.hash,
                label: x.created_contract?.hash,
                url: `https://robinhoodchain.blockscout.com/tx/${x.hash}`,
              })),
            });
          }
        } catch {
          /* optional */
        }
      }
    };

    // Nothing in a token's reads depends on the previous token, and the holders
    // call alone measures in seconds, so a strictly serial pass over 250 tokens
    // could not finish inside the poll interval.
    let next = 0;
    const drain = async () => {
      for (;;) {
        const t = items[next++];
        if (!t) return;
        try {
          await indexToken(t);
        } catch (e) {
          // One token that cannot be written must not take the rest of the
          // pass with it, which is easy to do once these run together.
          console.warn("[rh-indexer] token", e instanceof Error ? e.message : e);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, drain));
    unreadCreators = creatorUnreadable;
    console.log(`[rh-indexer] processed ${processed} tokens across ${pages} pages`);
  } catch (e) {
    console.warn("[rh-indexer] tokens", e instanceof Error ? e.message : e);
  }

  // Creator lookups that failed are a gap in this pass, not an absence of
  // creators, so the count is recorded rather than left implicit.
  await prisma.indexerCursor.upsert({
    where: { key: "rh_indexer" },
    create: {
      key: "rh_indexer",
      lastBlock: latest != null ? BigInt(latest) : BigInt(0),
      lastAt: new Date(),
      metaJson: JSON.stringify({ unreadCreators }),
    },
    update: {
      lastBlock: latest != null ? BigInt(latest) : undefined,
      lastAt: new Date(),
      metaJson: JSON.stringify({ unreadCreators }),
    },
  });
}

async function upsertEvent(e: {
  chain: string;
  eventClass: EventClass;
  title: string;
  detail: string;
  tokenAddress?: string;
  addresses: string[];
  confidence: string;
  txHashes: string[];
  evidence: object[];
}) {
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const existing = await prisma.riskEvent.findFirst({
    where: {
      chain: e.chain,
      eventClass: e.eventClass,
      tokenAddress: e.tokenAddress,
      title: e.title,
      createdAt: { gte: since },
    },
  });
  if (existing) return existing;

  return prisma.riskEvent.create({
    data: {
      chain: e.chain,
      eventClass: e.eventClass,
      title: e.title,
      detail: e.detail,
      tokenAddress: e.tokenAddress,
      addressesJson: jstr(e.addresses.map((a) => a.toLowerCase())),
      confidence: e.confidence,
      autoDetected: true,
      manualStatus: "pending",
      evidenceJson: jstr(e.evidence),
      txHashesJson: jstr(e.txHashes),
      occurredAt: new Date(),
    },
  });
}
