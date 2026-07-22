import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma, jstr } from "@rugkiller/db";
import { config } from "../config.js";
import { authenticatedAddress } from "../services/auth.js";

function isAdmin(wallet?: string | null) {
  if (!wallet) return false;
  return config.adminWallets.includes(wallet.toLowerCase());
}

export async function adminRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/admin")) return;
    const wallet = authenticatedAddress(req.headers);
    // The public /health endpoint is used by hosting. Detailed admin health is dev-only without auth.
    if (process.env.NODE_ENV === "development" && req.method === "GET" && req.url === "/admin/health") return;
    if (!config.adminWallets.length && process.env.NODE_ENV === "development") return;
    if (!isAdmin(wallet)) {
      return reply.code(403).send({ error: "admin_required" });
    }
  });

  app.get("/admin/health", async () => {
    const [sources, cursors, failedAnalyses, openAppeals, pendingEvents, payments] =
      await Promise.all([
        prisma.dataSourceHealth.findMany(),
        prisma.indexerCursor.findMany(),
        prisma.token.count({ where: { overallRisk: null } }),
        prisma.appeal.count({ where: { status: "open" } }),
        prisma.riskEvent.count({ where: { manualStatus: "pending" } }),
        prisma.payment.groupBy({ by: ["status"], _count: true }),
      ]);

    return {
      sources,
      cursors: cursors.map((c) => ({
        ...c,
        lastBlock: c.lastBlock.toString(),
      })),
      stats: {
        tokensUnscored: failedAnalyses,
        openAppeals,
        pendingEvents,
        payments,
      },
      paymentNetwork: {
        key: config.paymentNetwork.key,
        chainId: config.paymentNetwork.chainId,
        name: config.paymentNetwork.name,
      },
      analysisNetworks: Object.values(config.networks)
        .filter((n) => n.isAnalysisNetwork)
        .map((n) => ({ key: n.key, chainId: n.chainId, name: n.name })),
      riskModelVersion: config.riskModelVersion,
    };
  });

  app.get("/admin/events/review", async () => {
    const items = await prisma.riskEvent.findMany({
      where: { OR: [{ manualStatus: "pending" }, { manualStatus: "none", autoDetected: true }] },
      orderBy: { occurredAt: "desc" },
      take: 50,
    });
    return { items };
  });

  app.post("/admin/events/:id/review", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        manualStatus: z.enum(["confirmed", "rejected", "pending"]),
        reason: z.string().min(3),
      })
      .parse(req.body);
    const wallet = authenticatedAddress(req.headers) ?? "admin";
    const before = await prisma.riskEvent.findUnique({ where: { id } });
    if (!before) return reply.code(404).send({ error: "not_found" });

    const after = await prisma.riskEvent.update({
      where: { id },
      data: {
        manualStatus: body.manualStatus,
        manualReason: body.reason,
      },
    });

    await prisma.auditLog.create({
      data: {
        actor: wallet,
        action: "risk_event_review",
        entity: id,
        beforeJson: jstr(before),
        afterJson: jstr(after),
      },
    });

    return { event: after };
  });

  app.get("/admin/appeals", async () => {
    const items = await prisma.appeal.findMany({
      where: { status: { in: ["open", "in_review"] } },
      orderBy: { createdAt: "asc" },
      take: 100,
    });
    return { items };
  });

  app.post("/admin/appeals/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        status: z.enum(["accepted", "rejected", "in_review"]),
        decisionReason: z.string().min(3),
      })
      .parse(req.body);
    const wallet = authenticatedAddress(req.headers) ?? "admin";
    const before = await prisma.appeal.findUnique({ where: { id } });
    if (!before) return reply.code(404).send({ error: "not_found" });
    const after = await prisma.appeal.update({
      where: { id },
      data: { status: body.status, decisionReason: body.decisionReason },
    });
    // Manual review does NOT delete automatic findings
    await prisma.auditLog.create({
      data: {
        actor: wallet,
        action: "appeal_decision",
        entity: id,
        beforeJson: jstr(before),
        afterJson: jstr(after),
      },
    });
    return { appeal: after };
  });

  app.post("/admin/findings/:id/override", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        decision: z.string(),
        reason: z.string().min(3),
      })
      .parse(req.body);
    const wallet = authenticatedAddress(req.headers) ?? "admin";
    const before = await prisma.finding.findUnique({ where: { id } });
    if (!before) return reply.code(404).send({ error: "not_found" });
    const after = await prisma.finding.update({
      where: { id },
      data: {
        manualDecision: body.decision,
        manualReason: body.reason,
        manualReviewer: wallet,
        manualAt: new Date(),
      },
    });
    await prisma.auditLog.create({
      data: {
        actor: wallet,
        action: "finding_override",
        entity: id,
        beforeJson: jstr(before),
        afterJson: jstr(after),
      },
    });
    return { finding: after };
  });

  app.get("/admin/payments", async () => {
    const items = await prisma.payment.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return { items };
  });

  app.get("/admin/audit", async () => {
    const items = await prisma.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return { items };
  });
}
