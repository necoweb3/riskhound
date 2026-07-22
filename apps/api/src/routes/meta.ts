import type { FastifyInstance } from "fastify";
import { prisma } from "@rugkiller/db";
import { DISCLAIMER, OVERALL_LABELS, EVENT_CLASS_LABELS, LINK_STRENGTH_LABELS } from "@rugkiller/shared";
import { config } from "../config.js";
import { getArcClients, getRobinhoodClients } from "@rugkiller/chain";

export async function metaRoutes(app: FastifyInstance) {
  app.get("/health", async () => {
    let dbOk = false;
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbOk = true;
    } catch {
      dbOk = false;
    }

    const sources = await prisma.dataSourceHealth.findMany();
    return {
      ok: dbOk,
      service: "riskhound-api",
      db: dbOk,
      sources,
      time: new Date().toISOString(),
    };
  });

  app.get("/status/sources", async () => {
    const arc = getArcClients();
    const rh = getRobinhoodClients();
    const results = [];

    for (const [key, client, name] of [
      ["arc_explorer", arc.explorer, "Arc Blockscout"],
      ["rh_explorer", rh.explorer, "Robinhood Blockscout"],
    ] as const) {
      try {
        const b = await client.getLatestBlock();
        const row = await prisma.dataSourceHealth.upsert({
          where: { key },
          create: {
            key,
            name,
            healthy: b != null,
            lastSuccessAt: b ? new Date() : null,
            lastBlock: b ? BigInt(b.number) : null,
          },
          update: {
            healthy: b != null,
            lastSuccessAt: b ? new Date() : undefined,
            lastBlock: b ? BigInt(b.number) : undefined,
            lastError: b ? null : "no block",
          },
        });
        results.push({
          key,
          name,
          healthy: row.healthy,
          lastBlock: row.lastBlock?.toString() ?? null,
          lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
          lastError: row.lastError,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await prisma.dataSourceHealth.upsert({
          where: { key },
          create: { key, name, healthy: false, lastError: msg },
          update: { healthy: false, lastError: msg },
        });
        results.push({ key, name, healthy: false, lastError: msg });
      }
    }

    // RPC
    try {
      if (arc.rpc) {
        const bn = await arc.rpc.getBlockNumber();
        results.push({ key: "arc_rpc", name: "Arc RPC", healthy: true, lastBlock: bn.toString() });
      } else {
        results.push({ key: "arc_rpc", name: "Arc RPC", healthy: false, lastError: "not configured" });
      }
    } catch (e) {
      results.push({
        key: "arc_rpc",
        name: "Arc RPC",
        healthy: false,
        lastError: e instanceof Error ? e.message : String(e),
      });
    }

    return { sources: results };
  });

  app.get("/methodology", async () => ({
    product: "RiskHound",
    disclaimer: DISCLAIMER,
    principles: [
        "Every risk signal is backed by showable onchain evidence.",
      "AI never invents risk; optional AI only explains existing evidence.",
      "Addresses are never labeled scammer/rugger without sufficient evidence.",
      "Risk level and link confidence are separate dimensions.",
      "Missing data is not treated as safety.",
      "A CCTP source burn, Circle attestation, and Arc destination mint are separate states.",
      "No trade execution, no custody, no investment advice.",
    ],
    overallLevels: OVERALL_LABELS,
    eventClasses: EVENT_CLASS_LABELS,
    linkStrengths: LINK_STRENGTH_LABELS,
    categories: [
      "contract",
      "owner_admin",
      "buy_sell",
      "liquidity",
      "holder_concentration",
      "insider_links",
      "deployer_history",
      "cross_chain",
      "market_behavior",
      "data_gaps",
    ],
    scoring: {
      modelVersion: config.riskModelVersion,
      notes: [
        "Category scores emphasize the worst finding so averages cannot hide critical issues.",
        "Confirmed honeypot or critical privilege elevates overall to critical.",
        "Automatic detections remain visible after manual review; overrides are audited.",
      ],
    },
    networks: {
      analysis: Object.values(config.networks)
        .filter((n) => n.isAnalysisNetwork)
        .map((n) => ({
          key: n.key,
          name: n.name,
          chainId: n.chainId,
          explorer: n.explorerUrl,
          testnet: n.isTestnet,
        })),
      payment: {
        key: config.paymentNetwork.key,
        name: config.paymentNetwork.name,
        chainId: config.paymentNetwork.chainId,
        note: "Independent of analysis networks. Arc mainnet payments can be enabled via config when available.",
      },
    },
    limitations: [
        "Arc DEX registries may be incomplete. Liquidity USD can be unavailable.",
      "Sell simulation without a known router is transfer-path based and may be inconclusive.",
      "Outside-chain history is shown only after the address relationship and evidence are confirmed.",
      "Bridge Watch is a recent Base CCTP sample and must not be read as an all-time queue total.",
      "Social signals are contextual only and never replace chain evidence.",
    ],
  }));

  app.get("/networks", async () => ({
    networks: config.networks,
    payment: config.paymentNetwork,
  }));
}
