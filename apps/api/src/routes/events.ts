import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma, jparse } from "@rugkiller/db";

export async function eventRoutes(app: FastifyInstance) {
  app.get("/events", async (req) => {
    const q = z
      .object({
        chain: z.string().optional(),
        eventClass: z.string().optional(),
        limit: z.coerce.number().min(1).max(100).default(40),
        offset: z.coerce.number().min(0).default(0),
      })
      .parse(req.query);

    const where: Record<string, unknown> = {};
    if (q.chain) where.chain = q.chain;
    if (q.eventClass) where.eventClass = q.eventClass;

    const [items, total] = await Promise.all([
      prisma.riskEvent.findMany({
        where,
        orderBy: { occurredAt: "desc" },
        take: q.limit,
        skip: q.offset,
      }),
      prisma.riskEvent.count({ where }),
    ]);

    return {
      total,
      items: items.map((e) => ({
        id: e.id,
        chain: e.chain,
        eventClass: e.eventClass,
        title: e.title,
        detail: e.detail,
        tokenAddress: e.tokenAddress,
        addresses: jparse(e.addressesJson, []),
        confidence: e.confidence,
        autoDetected: e.autoDetected,
        manualStatus: e.manualStatus,
        manualReason: e.manualReason,
        evidence: jparse(e.evidenceJson, []),
        txHashes: jparse(e.txHashesJson, []),
        occurredAt: e.occurredAt.toISOString(),
      })),
    };
  });
}
