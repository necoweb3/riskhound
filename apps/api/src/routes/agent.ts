import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { analyzeToken } from "@rugkiller/analysis";
import { normalizeAddress } from "@rugkiller/chain";
import { loadRhRiskEventsForAddresses, persistAnalysis } from "../services/persist.js";

/**
 * Structured, agent-friendly answers over the same analysis the site runs.
 *
 * These used to sit behind an x402 payment gate. That product was cancelled,
 * so the gate, the Circle facilitator client and the quote/settlement plumbing
 * are gone. Cost control is a rate limit now, not a paywall.
 */
const QUESTIONS = [
  "critical_contract_risk",
  "can_sell",
  "deployer_risky_history",
  "creator_confirmed_external_history",
  "deployer_robinhood_link",
  "wallet_funded_from_risk_event",
  "holder_linked_pct",
  "recent_critical_liquidity",
  "block_trade_risk",
  "funding_link_between",
  "shortest_path_to_risk",
] as const;

export async function agentRoutes(app: FastifyInstance) {
  // Each of these runs a full analysis, so they get their own budget.
  const heavyRoute = { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } };

  app.post("/v1/agent/query", heavyRoute, async (req, reply) => {
    const body = z
      .object({
        question: z.enum(QUESTIONS),
        token: z.string().optional(),
        wallet: z.string().optional(),
        walletB: z.string().optional(),
      })
      .parse(req.body);

    if (!body.token && !body.wallet) {
      return reply.code(400).send({ error: "token_or_wallet_required" });
    }

    const norm = normalizeAddress(body.token ?? body.wallet!);
    if (!norm) return reply.code(400).send({ error: "invalid_address" });

    // Confirmed outside-chain events are the only source of creator-history
    // links, so a query that answers on relatedEventIds has to load them or it
    // reports "no history" for every token.
    const events = await loadRhRiskEventsForAddresses([]);
    const result = await analyzeToken({ address: norm, rhRiskEvents: events });
    const d = result.detail;
    const report = result.report;

    const base = {
      riskLevel: report.overall,
      confidence: report.confidence,
      analyzedAt: report.analyzedAt,
      dataFreshness: { lastBlock: report.lastBlock, sources: report.dataSources },
      modelVersion: report.modelVersion,
      addresses: { token: d.address, deployer: d.deployer, owner: d.owner },
      disclaimer: report.disclaimer,
    };

    switch (body.question) {
      case "critical_contract_risk": {
        const crit = report.topFindings.filter(
          (f) => f.severity === "critical" || f.category === "contract"
        );
        return {
          ...base,
          answer: crit.some((f) => f.severity === "critical"),
          criticalFindings: crit,
          evidence: crit.flatMap((f) => f.evidence),
        };
      }
      case "can_sell":
        return {
          ...base,
          answer: d.simulation?.canSell ?? null,
          canBuy: d.simulation?.canBuy ?? null,
          steps: d.simulation?.steps ?? [],
          summary: d.simulation?.summary,
          evidence: d.simulation?.steps.flatMap((s) => s.evidence ?? []) ?? [],
        };
      case "deployer_risky_history":
        return {
          ...base,
          answer: (d.deployerProfile?.previousTokens.length ?? 0) > 0,
          previousTokens: d.deployerProfile?.previousTokens ?? [],
          historyLabel: d.deployerProfile?.historyLabel,
        };
      case "creator_confirmed_external_history":
      case "deployer_robinhood_link": {
        const riskLinks = d.crossChainLinks.filter((link) => link.relatedEventIds.length > 0);
        return {
          ...base,
          answer: riskLinks.length > 0,
          links: riskLinks,
          evidence: riskLinks.flatMap((link) => link.evidence),
        };
      }
      case "holder_linked_pct": {
        // The answer is the linked share, not the cluster list itself.
        const linkedPct = d.insiderClusters.reduce((a, c) => a + (c.totalPct ?? 0), 0);
        return {
          ...base,
          answer: d.insiderClusters.some((c) => c.totalPct != null) ? linkedPct : null,
          clusters: d.insiderClusters,
        };
      }
      case "recent_critical_liquidity":
        return {
          ...base,
          answer: (d.liquidity?.recentRemoves.length ?? 0) > 0,
          removes: d.liquidity?.recentRemoves ?? [],
        };
      case "block_trade_risk": {
        const block =
          report.overall === "critical_risk" ||
          d.simulation?.canSell === false ||
          report.topFindings.some((f) => f.severity === "critical");
        return {
          ...base,
          answer: block,
          reason: block
            ? "Critical findings or failed sell simulation. Agents should not treat it as safe to trade."
            : "No automatic hard-block signal; still not a safety guarantee.",
          topFindings: report.topFindings,
        };
      }
      case "funding_link_between": {
        if (!body.walletB) return reply.code(400).send({ error: "walletB_required" });
        const b = normalizeAddress(body.walletB)?.toLowerCase();
        if (!b) return reply.code(400).send({ error: "invalid_walletB" });
        const a = norm.toLowerCase();
        // Both endpoints must appear on the same link.
        const hits = d.crossChainLinks.filter(
          (l) =>
            (l.fromAddress === a && l.toAddress === b) ||
            (l.fromAddress === b && l.toAddress === a)
        );
        return { ...base, answer: hits.length > 0, links: hits };
      }
      case "shortest_path_to_risk":
        return { ...base, answer: result.graph.hopsToRisk, graph: result.graph };
      case "wallet_funded_from_risk_event":
        return {
          ...base,
          answer: d.crossChainLinks.some((l) => l.relatedEventIds.length > 0),
          links: d.crossChainLinks.filter((l) => l.relatedEventIds.length > 0),
        };
      default:
        return reply.code(400).send({ error: "unknown_question" });
    }
  });

  app.post("/v1/report", heavyRoute, async (req, reply) => {
    const body = z.object({ address: z.string() }).parse(req.body);
    const norm = normalizeAddress(body.address);
    if (!norm) return reply.code(400).send({ error: "invalid_address" });
    const events = await loadRhRiskEventsForAddresses([]);
    const result = await analyzeToken({ address: norm, rhRiskEvents: events });
    await persistAnalysis(result);
    return {
      detail: result.detail,
      report: result.report,
      graph: result.graph,
      errors: result.errors,
    };
  });

  app.post("/v1/funding-graph", heavyRoute, async (req, reply) => {
    const body = z.object({ address: z.string() }).parse(req.body);
    const norm = normalizeAddress(body.address);
    if (!norm) return reply.code(400).send({ error: "invalid_address" });
    const events = await loadRhRiskEventsForAddresses([]);
    const result = await analyzeToken({ address: norm, skipSimulation: true, rhRiskEvents: events });
    return { graph: result.graph, links: result.detail.crossChainLinks };
  });

  app.post("/v1/simulation", heavyRoute, async (req, reply) => {
    const body = z.object({ address: z.string() }).parse(req.body);
    const norm = normalizeAddress(body.address);
    if (!norm) return reply.code(400).send({ error: "invalid_address" });
    const result = await analyzeToken({ address: norm });
    return { simulation: result.detail.simulation };
  });
}
