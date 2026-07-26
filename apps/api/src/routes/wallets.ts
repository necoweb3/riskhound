import type { FastifyInstance } from "fastify";
import { prisma, jparse } from "@rugkiller/db";
import { getArcClients, normalizeAddress } from "@rugkiller/chain";
import { buildDeployerProfile } from "@rugkiller/analysis";
import { tokenRowToSummary } from "../services/persist.js";

const MAX_WALLET_RISK_EVENTS = 200;

/**
 * Risk events keep their addresses in a JSON array, so the wallet filter has to
 * run in SQL over a lowercased form. Loading a fixed page of the newest events
 * and filtering in JS hid every older confirmed event for this wallet.
 */
async function confirmedRiskEventsFor(address: string) {
  const matches = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "RiskEvent"
    WHERE "manualStatus" = 'confirmed'
      AND lower("addressesJson") LIKE ${`%${address}%`}
    ORDER BY "occurredAt" DESC
    LIMIT ${MAX_WALLET_RISK_EVENTS}
  `;
  if (!matches.length) return [];
  const rows = await prisma.riskEvent.findMany({
    where: { id: { in: matches.map((row) => row.id) } },
    orderBy: { occurredAt: "desc" },
  });
  // LIKE can match inside a longer value, so membership is confirmed exactly.
  return rows.filter((row) =>
    jparse<string[]>(row.addressesJson, []).some((value) => value.toLowerCase() === address)
  );
}

export async function walletRoutes(app: FastifyInstance) {
  app.get("/wallets/:address", async (req, reply) => {
    const { address } = req.params as { address: string };
    const norm = normalizeAddress(address);
    if (!norm) return reply.code(400).send({ error: "invalid_address" });
    const a = norm.toLowerCase();

    const arc = getArcClients();
    const [arcProfile, tokens, deployStats, linkedEvents, stored] = await Promise.all([
      buildDeployerProfile({ chain: "arc_testnet", address: a, explorer: arc.explorer }),
      prisma.token.findMany({
        where: { deployer: a },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
      // Counts and first/last seen cover the whole deploy history; the list
      // above is only the newest page of it.
      prisma.token.groupBy({
        by: ["chain"],
        where: { deployer: a },
        _count: { _all: true },
        _min: { createdAt: true },
        _max: { createdAt: true },
      }),
      confirmedRiskEventsFor(a),
      prisma.wallet.findMany({ where: { address: a } }),
    ]);

    const testnetStats = deployStats.find((row) => row.chain === "arc_testnet");
    const observedStats = deployStats.find((row) => row.chain === "arc_observed_5042");

    return {
      address: a,
      chains: [
        {
          chain: "arc_testnet",
          firstSeenAt: arcProfile.firstSeenAt,
          lastSeenAt: arcProfile.lastSeenAt,
          txCount: null,
          tokensDeployed: testnetStats?._count._all ?? 0,
          labels: jparse(
            stored.find((s) => s.chain === "arc_testnet")?.labelsJson,
            [] as string[]
          ),
          historyLabel: arcProfile.historyLabel,
        },
        ...(observedStats ? [{
          chain: "arc_observed_5042",
          firstSeenAt: observedStats._min.createdAt?.toISOString() ?? null,
          lastSeenAt: observedStats._max.createdAt?.toISOString() ?? null,
          txCount: null,
          tokensDeployed: observedStats._count._all,
          labels: jparse(stored.find((s) => s.chain === "arc_observed_5042")?.labelsJson, [] as string[]),
          historyLabel: "observed",
        }] : []),
      ],
      fundingSources: arcProfile.firstFunder
        ? [{ chain: "arc_testnet", from: arcProfile.firstFunder }]
        : [],
      deployedTokens: tokens.map(tokenRowToSummary),
      riskEvents: linkedEvents.map((e) => ({
        id: e.id,
        chain: e.chain,
        eventClass: e.eventClass,
        title: e.title,
        tokenAddress: e.tokenAddress,
        addresses: jparse(e.addressesJson, []),
        confidence: e.confidence,
        autoDetected: e.autoDetected,
        manualStatus: e.manualStatus,
        occurredAt: e.occurredAt.toISOString(),
        evidence: jparse(e.evidenceJson, []),
      })),
      note:
        "This profile covers tracked Arc activity. Outside-chain history appears only when the address link and evidence have been confirmed.",
    };
  });
}
