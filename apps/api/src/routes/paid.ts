import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { analyzeToken } from "@rugkiller/analysis";
import { normalizeAddress } from "@rugkiller/chain";
import type { PaidFeature } from "@rugkiller/shared";
import {
  buildQuote,
  featureCatalog,
  newRequestId,
  paymentRequiredHeader,
  settleVerifiedPayment,
  verifyPayment,
} from "../services/x402.js";
import { loadRhRiskEventsForAddresses, persistAnalysis } from "../services/persist.js";
import { config } from "../config.js";

async function requirePaid(
  app: FastifyInstance,
  req: { headers: Record<string, unknown> },
  reply: {
    code: (n: number) => { send: (b: unknown) => unknown; header: (k: string, v: string) => unknown };
    header: (k: string, v: string) => unknown;
  },
  feature: PaidFeature
) {
  const requestId =
    (req.headers["x-payment-request-id"] as string | undefined) ?? newRequestId();
  if (!config.x402Enabled) return { paid: true as const, requestId, paymentHeader: null };
  const paymentHeader = (req.headers["payment-signature"] ?? req.headers["x-payment"]) as string | undefined;
  if (paymentHeader) {
    try {
      await verifyPayment(feature, paymentHeader);
      return { paid: true as const, requestId, paymentHeader };
    } catch (error) {
      reply.code(402).send({ error: "payment_invalid", message: error instanceof Error ? error.message : String(error) });
      return { paid: false as const, requestId, paymentHeader: null };
    }
  }

  const quote = buildQuote(feature);
  const required = await paymentRequiredHeader(feature, `${config.publicUrl}${(req as { url?: string }).url ?? ""}`);
  reply.header("PAYMENT-REQUIRED", required);
  reply.header("X-Payment-Request-Id", requestId);
  reply.code(402).send({
    error: "payment_required",
    message: `This endpoint requires a Circle Gateway x402 payment in USDC on ${config.paymentNetwork.name}.`,
    quote,
    paymentNetwork: {
      name: config.paymentNetwork.name,
      chainId: config.paymentNetwork.chainId,
      key: config.paymentNetwork.key,
      note: "Payment network is independent of Arc analysis network.",
    },
    feature,
  });
  return { paid: false as const, requestId };
}

async function settleGate(
  gate: { requestId: string; paymentHeader: string | null },
  feature: PaidFeature,
  req: { headers: Record<string, unknown> }
) {
  if (!gate.paymentHeader) return;
  await settleVerifiedPayment({
    feature,
    requestId: gate.requestId,
    header: gate.paymentHeader,
    payerAddress: req.headers["x-wallet-address"] as string | undefined,
  });
}

export async function paidRoutes(app: FastifyInstance) {
  app.get("/v1/pricing", async () => ({
    features: featureCatalog(),
    paymentNetwork: {
      key: config.paymentNetwork.key,
      name: config.paymentNetwork.name,
      chainId: config.paymentNetwork.chainId,
      usdc: config.paymentNetwork.usdcAddress,
      recipient: config.paymentRecipient,
    },
    free: {
      tokenList: true,
      basicTokenLookup: true,
      methodology: true,
    },
    notes: [
      "Pay with USDC via x402 on the configured payment network.",
      "Analysis targets Arc; outside-chain data is supporting creator-history evidence only.",
      "Max spend is always shown before charge.",
    ],
  }));

  app.get("/v1/quote/:feature", async (req, reply) => {
    const { feature } = req.params as { feature: string };
    if (!featureCatalog().some((f) => f.feature === feature)) {
      return reply.code(404).send({ error: "unknown_feature" });
    }
    const quote = buildQuote(feature as PaidFeature);
    return { quote, requestId: newRequestId() };
  });

  // Agent-friendly structured security Q&A
  app.post("/v1/agent/query", async (req, reply) => {
    const body = z
      .object({
        question: z.enum([
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
        ]),
        token: z.string().optional(),
        wallet: z.string().optional(),
        walletB: z.string().optional(),
      })
      .parse(req.body);

    // Basic questions free; deep ones paid
    const paidQuestions = new Set([
      "creator_confirmed_external_history",
      "deployer_robinhood_link",
      "wallet_funded_from_risk_event",
      "holder_linked_pct",
      "funding_link_between",
      "shortest_path_to_risk",
      "can_sell",
    ]);

    let agentGate: Awaited<ReturnType<typeof requirePaid>> | null = null;
    if (paidQuestions.has(body.question)) {
      agentGate = await requirePaid(app, req, reply as never, "full_report");
      if (!agentGate.paid) return;
    }

    if (!body.token && !body.wallet) {
      return reply.code(400).send({ error: "token_or_wallet_required" });
    }

    const address = body.token ?? body.wallet!;
    const norm = normalizeAddress(address);
    if (!norm) return reply.code(400).send({ error: "invalid_address" });

    const result = await analyzeToken({ address: norm });
    const d = result.detail;
    const report = result.report;

    if (agentGate?.paid) await settleGate(agentGate, "full_report", req);

    const base = {
      riskLevel: report.overall,
      confidence: report.confidence,
      analyzedAt: report.analyzedAt,
      dataFreshness: {
        lastBlock: report.lastBlock,
        sources: report.dataSources,
      },
      modelVersion: report.modelVersion,
      addresses: {
        token: d.address,
        deployer: d.deployer,
        owner: d.owner,
      },
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
      case "holder_linked_pct":
        return {
          ...base,
          answer: d.insiderClusters,
          clusters: d.insiderClusters,
        };
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
        const a = norm.toLowerCase();
        const hits = d.crossChainLinks.filter(
          (l) =>
            (l.fromAddress === a && l.toAddress === b) ||
            (l.fromAddress === b && l.toAddress === a) ||
            (l.fromAddress === a || l.toAddress === a)
        );
        return { ...base, answer: hits.length > 0, links: hits };
      }
      case "shortest_path_to_risk":
        return {
          ...base,
          answer: result.graph.hopsToRisk,
          graph: result.graph,
        };
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

  app.post("/v1/paid/full-report", async (req, reply) => {
    const gate = await requirePaid(app, req, reply as never, "full_report");
    if (!gate.paid) return;
    const body = z.object({ address: z.string() }).parse(req.body);
    const norm = normalizeAddress(body.address);
    if (!norm) return reply.code(400).send({ error: "invalid_address" });
    const events = await loadRhRiskEventsForAddresses([]);
    const result = await analyzeToken({ address: norm, rhRiskEvents: events });
    await persistAnalysis(result);
    await settleGate(gate, "full_report", req);
    return {
      paid: true,
      requestId: gate.requestId,
      paymentNetwork: config.paymentNetwork.key,
      detail: result.detail,
      report: result.report,
      graph: result.graph,
      errors: result.errors,
    };
  });

  app.post("/v1/paid/funding-graph", async (req, reply) => {
    const gate = await requirePaid(app, req, reply as never, "funding_graph");
    if (!gate.paid) return;
    const body = z.object({ address: z.string() }).parse(req.body);
    const norm = normalizeAddress(body.address);
    if (!norm) return reply.code(400).send({ error: "invalid_address" });
    const result = await analyzeToken({ address: norm, skipSimulation: true });
    await settleGate(gate, "funding_graph", req);
    return { paid: true, graph: result.graph, links: result.detail.crossChainLinks };
  });

  app.post("/v1/paid/simulation", async (req, reply) => {
    const gate = await requirePaid(app, req, reply as never, "buy_sell_sim");
    if (!gate.paid) return;
    const body = z.object({ address: z.string() }).parse(req.body);
    const norm = normalizeAddress(body.address);
    if (!norm) return reply.code(400).send({ error: "invalid_address" });
    const result = await analyzeToken({ address: norm });
    await settleGate(gate, "buy_sell_sim", req);
    return { paid: true, simulation: result.detail.simulation };
  });
}
