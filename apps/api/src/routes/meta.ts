import type { FastifyInstance } from "fastify";
import { prisma, jparse } from "@rugkiller/db";
import {
  DISCLAIMER,
  OVERALL_LABELS,
  EVENT_CLASS_LABELS,
  LINK_STRENGTH_LABELS,
  type RiskReport,
} from "@rugkiller/shared";
import { config } from "../config.js";
import { getArcClients, getRobinhoodClients } from "@rugkiller/chain";

/** Landing page counters and live sample. Every number is a real row count. */
async function buildStats() {
  const [contractsIndexed, findingsWithEvidence, creatorsTracked, latestToken] =
    await Promise.all([
      prisma.token.count({ where: { chain: "arc_testnet" } }),
      // A finding only counts as "with proof" when it carries evidence refs.
      prisma.finding.count({ where: { evidenceJson: { notIn: ["[]", "null", ""] } } }),
      prisma.wallet.count({ where: { chain: "arc_testnet" } }),
      prisma.token.findFirst({
        where: { chain: "arc_testnet", analysisUpdatedAt: { not: null } },
        orderBy: { analysisUpdatedAt: "desc" },
        include: {
          analyses: { orderBy: { createdAt: "desc" }, take: 1 },
          simulations: { orderBy: { createdAt: "desc" }, take: 1 },
        },
      }),
    ]);

  const counts = { contractsIndexed, findingsWithEvidence, creatorsTracked };
  if (!latestToken) return { counts, latest: null };

  const report = jparse<RiskReport | null>(latestToken.analyses[0]?.reportJson, null);
  const sim = latestToken.simulations[0] ?? null;
  const findings = report?.topFindings ?? [];
  const categories = report?.categories ?? [];
  const scoreOf = (key: string) => categories.find((c) => c.category === key)?.score ?? null;
  const holderScore = scoreOf("holder_concentration");
  const crossChainCount = findings.filter((f) => f.category === "cross_chain").length;

  const rows = [
    {
      label: "Bytecode and ABI surface",
      value: latestToken.bytecodeHash ? "READ" : "UNAVAILABLE",
      tone: latestToken.bytecodeHash ? "green" : "muted",
    },
    {
      label: "Buy leg simulated",
      value: sim?.canBuy === true ? "PASSED" : sim?.canBuy === false ? "REVERTED" : "UNCLEAR",
      tone: sim?.canBuy === true ? "green" : sim?.canBuy === false ? "red" : "muted",
    },
    {
      label: "Sell leg simulated",
      value: sim?.canSell === true ? "PASSED" : sim?.canSell === false ? "REVERTED" : "UNCLEAR",
      tone: sim?.canSell === true ? "green" : sim?.canSell === false ? "red" : "muted",
    },
    {
      label: "Holder graph resolved",
      value:
        latestToken.holderCount != null
          ? `${latestToken.holderCount} HOLDERS`
          : "UNAVAILABLE",
      tone: holderScore != null && holderScore >= 70 ? "amber" : "muted",
    },
    {
      label: "Creator history matched",
      value: crossChainCount > 0 ? `${crossChainCount} EVENTS` : "NONE FOUND",
      tone: crossChainCount > 0 ? "amber" : "muted",
    },
  ];

  // The dial reads the same number the token report shows: the worst category.
  const scored = categories.filter((c) => c.category !== "data_gaps");
  const score = scored.length ? Math.max(...scored.map((c) => c.score)) : null;

  return {
    counts,
    latest: {
      address: latestToken.address,
      symbol: latestToken.symbol,
      name: latestToken.name,
      score,
      overall: latestToken.overallRisk,
      overallLabel: latestToken.overallRisk
        ? OVERALL_LABELS[latestToken.overallRisk as keyof typeof OVERALL_LABELS] ?? null
        : null,
      headline: findings[0]?.summary ?? null,
      analyzedAt: latestToken.analysisUpdatedAt?.toISOString() ?? null,
      rows,
    },
  };
}

export async function metaRoutes(app: FastifyInstance) {
  app.get("/stats", async () => buildStats());

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
