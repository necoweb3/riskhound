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

  try {
    // Walk the explorer pages instead of the first slice of page one, so tokens
    // past the newest few are indexed at all. Bounded to keep one poll finite.
    const maxPagesEnv = Number(process.env.ROBINHOOD_INDEXER_MAX_PAGES ?? 5);
    const maxPages = Number.isFinite(maxPagesEnv) && maxPagesEnv >= 1 ? Math.floor(maxPagesEnv) : 5;
    const items: BsTokenInfo[] = [];
    let cursor: Record<string, unknown> | null = null;
    let pages = 0;
    do {
      const page = await rh.explorer.getTokens({ type: "ERC-20", cursor });
      items.push(...(page.items ?? []));
      cursor = page.next_page_params ?? null;
      pages++;
    } while (cursor && pages < maxPages);

    let processed = 0;
    for (const t of items) {
      const address = (t.address ?? t.address_hash ?? "").toLowerCase();
      if (!address.startsWith("0x")) continue;
      processed++;

      let deployer: string | null = null;
      let deployTx: string | null = null;
      try {
        const creation = await rh.explorer.getContractCreation(address);
        deployer = creation?.contractCreator?.toLowerCase() ?? null;
        deployTx = creation?.txHash ?? null;
      } catch {
        /* optional */
      }

      if (deployer) {
        await prisma.wallet.upsert({
          where: { chain_address: { chain: "robinhood", address: deployer } },
          create: {
            chain: "robinhood",
            address: deployer,
            labelsJson: jstr(["deployer"]),
          },
          update: {},
        });
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
            if (pct >= 90 && deployer) {
              await upsertEvent({
                chain: "robinhood",
                eventClass: "heavy_insider_control",
                title: `High top-holder concentration on ${t.symbol ?? address.slice(0, 10)}`,
                detail: `Top holders control ~${pct.toFixed(1)}% of supply (explorer snapshot).`,
                tokenAddress: address,
                addresses: [
                  deployer,
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
        try {
          const txs = await rh.explorer.getAddressTransactions(deployer);
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
    }
    console.log(`[rh-indexer] processed ${processed} tokens across ${pages} pages`);
  } catch (e) {
    console.warn("[rh-indexer] tokens", e instanceof Error ? e.message : e);
  }

  await prisma.indexerCursor.upsert({
    where: { key: "rh_indexer" },
    create: {
      key: "rh_indexer",
      lastBlock: latest != null ? BigInt(latest) : BigInt(0),
      lastAt: new Date(),
    },
    update: {
      lastBlock: latest != null ? BigInt(latest) : undefined,
      lastAt: new Date(),
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
