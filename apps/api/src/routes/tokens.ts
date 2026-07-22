import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma, jparse } from "@rugkiller/db";
import { analyzeToken } from "@rugkiller/analysis";
import { getArcClients, getCode, normalizeAddress, readErc20Meta } from "@rugkiller/chain";
import {
  loadRhRiskEventsForAddresses,
  persistAnalysis,
  tokenRowToSummary,
} from "../services/persist.js";
import { enqueueAnalysis } from "../queue.js";

const listQuery = z.object({
  sort: z
    .enum([
      "newest",
      "liquidity",
      "holders",
      "high_risk",
      "critical",
      "robinhood",
      "new_deployer",
      "known_deployer",
      "unlocked_lp",
      "sim_fail",
    ])
    .optional()
    .default("newest"),
  q: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).optional().default(30),
  offset: z.coerce.number().min(0).optional().default(0),
  /** include raw contract stubs without metadata (default false) */
  all: z
    .enum(["true", "false"])
    .optional()
    .default("false")
    .transform((v) => v === "true"),
});

export async function tokenRoutes(app: FastifyInstance) {
  app.get("/tokens", async (req, reply) => {
    try {
      const q = listQuery.parse(req.query);

    // Prefer real or analyzed tokens. Hide bare "unknown" stubs from the feed.
      const baseWhere: Record<string, unknown> = {
        chain: "arc_testnet",
      };

      if (!q.all) {
        baseWhere.OR = [
          { name: { not: null } },
          { symbol: { not: null } },
          { analysisUpdatedAt: { not: null } },
          { standard: "ERC-20" },
          { holderCount: { gt: 0 } },
        ];
      }

      if (q.q) {
        const term = q.q.trim();
        baseWhere.AND = [
          {
            OR: [
              { address: { contains: term.toLowerCase() } },
              { name: { contains: term } },
              { symbol: { contains: term } },
            ],
          },
        ];
      }

      if (q.sort === "high_risk") baseWhere.overallRisk = { in: ["high_risk", "critical_risk"] };
      if (q.sort === "critical") baseWhere.overallRisk = "critical_risk";
      if (q.sort === "robinhood") baseWhere.hasRobinhoodLink = true;
      if (q.sort === "sim_fail") {
        baseWhere.topSignalsJson = { contains: "Sell path failed" };
      }

      // Default: recently analyzed first (more useful than raw deploys)
      let orderBy: object | object[] = [{ analysisUpdatedAt: "desc" }, { createdAt: "desc" }];
      if (q.sort === "liquidity") orderBy = [{ liquidityUsd: "desc" }, { createdAt: "desc" }];
      if (q.sort === "holders") orderBy = [{ holderCount: "desc" }, { createdAt: "desc" }];
      if (q.sort === "newest") {
        orderBy = [{ analysisUpdatedAt: "desc" }, { deployTimestamp: "desc" }, { createdAt: "desc" }];
      }

      const [items, total] = await Promise.all([
        prisma.token.findMany({
          where: baseWhere,
          orderBy,
          take: q.limit,
          skip: q.offset,
        }),
        prisma.token.count({ where: baseWhere }),
      ]);

      return {
        total,
        items: items.map(tokenRowToSummary),
        dataHealth: await prisma.dataSourceHealth.findMany(),
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to list tokens";
      return reply.code(400).send({ error: "list_failed", message });
    }
  });

  app.get("/tokens/:address", async (req, reply) => {
    try {
      const { address } = req.params as { address: string };
      const norm = normalizeAddress(address);
      if (!norm) return reply.code(400).send({ error: "invalid_address", message: "Invalid address" });

      const row = await prisma.token.findUnique({
        where: { chain_address: { chain: "arc_testnet", address: norm.toLowerCase() } },
        include: {
          analyses: { orderBy: { createdAt: "desc" }, take: 1 },
          findings: true,
          holders: { orderBy: { pct: "desc" }, take: 50 },
          simulations: { orderBy: { createdAt: "desc" }, take: 1 },
          pools: true,
        },
      });

      if (!row || !row.analyses[0]) {
        return reply.code(404).send({
          error: "not_analyzed",
          message: "Token not analyzed yet",
          address: norm,
        });
      }

      const report = jparse(row.analyses[0].reportJson, null);
      return {
        summary: tokenRowToSummary(row),
        report,
        findings: row.findings.map((f) => ({
          id: f.id,
          name: f.name,
          severity: f.severity,
          status: f.status,
          summary: f.summary,
          whyItMatters: f.whyItMatters,
          category: f.category,
          relatedFunction: f.relatedFunction,
          controllerAddress: f.controllerAddress,
          evidence: jparse(f.evidenceJson, []),
        })),
        holders: row.holders.map((h) => ({
          address: h.address,
          balance: h.balance,
          pct: h.pct,
          isContract: h.isContract,
          labels: jparse(h.labelsJson, [] as string[]),
        })),
        simulation: row.simulations[0]
          ? {
              canBuy: row.simulations[0].canBuy,
              canSell: row.simulations[0].canSell,
              buyTaxBps: row.simulations[0].buyTaxBps,
              sellTaxBps: row.simulations[0].sellTaxBps,
              summary: row.simulations[0].summary,
              method: row.simulations[0].method,
              dataComplete: row.simulations[0].dataComplete,
              steps: jparse(row.simulations[0].stepsJson, []),
            }
          : null,
        pools: row.pools,
        stale:
          !row.analysisUpdatedAt ||
          Date.now() - row.analysisUpdatedAt.getTime() > 15 * 60 * 1000,
        analysisUpdatedAt: row.analysisUpdatedAt?.toISOString(),
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to load token";
      return reply.code(500).send({ error: "token_load_failed", message });
    }
  });

  app.post("/tokens/:address/analyze", async (req, reply) => {
    const { address } = req.params as { address: string };
    const body = (req.body ?? {}) as { async?: boolean; force?: boolean };
    const norm = normalizeAddress(address);
    if (!norm) {
      return reply.code(400).send({ error: "invalid_address", message: "Invalid address" });
    }

    const clients = getArcClients();
    const [explorerToken, explorerAddress, rpcCode] = await Promise.all([
      clients.explorer.getToken(norm).catch(() => null),
      clients.explorer.getAddress(norm).catch(() => null),
      clients.rpc ? getCode(clients.rpc, norm) : Promise.resolve(null),
    ]);
    const isContract = explorerAddress?.is_contract === true || rpcCode != null;
    if (!isContract) {
      return reply.code(404).send({
        error: "token_not_found",
        message: "No token contract exists at this address on Arc Testnet.",
      });
    }

    let rpcMeta: Awaited<ReturnType<typeof readErc20Meta>> | null = null;
    if (!explorerToken && clients.rpc) {
      rpcMeta = await readErc20Meta(clients.rpc, norm).catch(() => null);
    }
    const isErc20 = explorerToken != null || rpcMeta?.totalSupply != null;
    if (!isErc20) {
      return reply.code(404).send({
        error: "token_not_found",
        message: "This address is a contract, but no ERC-20 token was found on Arc Testnet.",
      });
    }

    if (body.async) {
      const q = await enqueueAnalysis(norm.toLowerCase(), body.force);
      return { ...q, address: norm.toLowerCase() };
    }

    try {
      const events = await loadRhRiskEventsForAddresses([]);
      const result = await analyzeToken({ address: norm, rhRiskEvents: events });

      const token = await persistAnalysis(result);
      return {
        tokenId: token.id,
        detail: result.detail,
        report: result.report,
        graph: result.graph,
        errors: result.errors,
      };
    } catch (e) {
      return reply.code(502).send({
        error: "analysis_failed",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  });

  app.get("/tokens/:address/graph", async (req, reply) => {
    const { address } = req.params as { address: string };
    const norm = normalizeAddress(address);
    if (!norm) {
      return reply.code(400).send({ error: "invalid_address", message: "Invalid address" });
    }
    try {
      const result = await analyzeToken({
        address: norm,
        skipSimulation: true,
      });
      return result.graph;
    } catch (e) {
      return reply.code(502).send({
        error: "graph_failed",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  });
}
