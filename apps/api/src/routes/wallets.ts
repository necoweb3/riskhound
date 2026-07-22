import type { FastifyInstance } from "fastify";
import { prisma, jparse } from "@rugkiller/db";
import { getArcClients, normalizeAddress } from "@rugkiller/chain";
import { buildDeployerProfile } from "@rugkiller/analysis";
import { tokenRowToSummary } from "../services/persist.js";

export async function walletRoutes(app: FastifyInstance) {
  app.get("/wallets/:address", async (req, reply) => {
    const { address } = req.params as { address: string };
    const norm = normalizeAddress(address);
    if (!norm) return reply.code(400).send({ error: "invalid_address" });
    const a = norm.toLowerCase();

    const arc = getArcClients();
    const [arcProfile, tokens, events, stored] = await Promise.all([
      buildDeployerProfile({ chain: "arc_testnet", address: a, explorer: arc.explorer }),
      prisma.token.findMany({
        where: { deployer: a },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
      prisma.riskEvent.findMany({
        orderBy: { occurredAt: "desc" },
        take: 100,
      }),
      prisma.wallet.findMany({ where: { address: a } }),
    ]);

    const linkedEvents = events.filter((event) => {
      const addresses = jparse<string[]>(event.addressesJson, []).map((value) =>
        value.toLowerCase()
      );
      return addresses.includes(a) && event.manualStatus === "confirmed";
    });
    const testnetTokens = tokens.filter((token) => token.chain === "arc_testnet");
    const observedTokens = tokens.filter((token) => token.chain === "arc_observed_5042");
    const observedDates = observedTokens.map((token) => token.createdAt).sort((left, right) => left.getTime() - right.getTime());

    return {
      address: a,
      chains: [
        {
          chain: "arc_testnet",
          firstSeenAt: arcProfile.firstSeenAt,
          lastSeenAt: arcProfile.lastSeenAt,
          txCount: null,
          tokensDeployed: testnetTokens.length,
          labels: jparse(
            stored.find((s) => s.chain === "arc_testnet")?.labelsJson,
            [] as string[]
          ),
          historyLabel: arcProfile.historyLabel,
        },
        ...(observedTokens.length ? [{
          chain: "arc_observed_5042",
          firstSeenAt: observedDates[0]?.toISOString() ?? null,
          lastSeenAt: observedDates.at(-1)?.toISOString() ?? null,
          txCount: null,
          tokensDeployed: observedTokens.length,
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
