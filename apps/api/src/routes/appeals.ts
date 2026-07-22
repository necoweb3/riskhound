import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma, jstr } from "@rugkiller/db";
import { normalizeAddress } from "@rugkiller/chain";
import { authenticatedAddress } from "../services/auth.js";

export async function appealRoutes(app: FastifyInstance) {
  app.post("/appeals", async (req, reply) => {
    const body = z
      .object({
        entityType: z.enum(["token", "wallet", "event"]),
        chain: z.string(),
        address: z.string(),
        findingId: z.string().optional(),
        explanation: z.string().min(10).max(5000),
        evidenceUrls: z.array(z.string().url()).max(10).default([]),
      })
      .parse(req.body);

    const addr = normalizeAddress(body.address);
    if (!addr && body.entityType !== "event") {
      return reply.code(400).send({ error: "invalid_address" });
    }

    const wallet = authenticatedAddress(req.headers);
    let userId: string | undefined;
    if (wallet && normalizeAddress(wallet)) {
      const user = await prisma.user.upsert({
        where: { walletAddress: wallet },
        create: { walletAddress: wallet },
        update: {},
      });
      userId = user.id;
    }

    const appeal = await prisma.appeal.create({
      data: {
        userId,
        entityType: body.entityType,
        chain: body.chain,
        address: (addr ?? body.address).toLowerCase(),
        findingId: body.findingId,
        explanation: body.explanation,
        evidenceUrlsJson: jstr(body.evidenceUrls),
        status: "open",
      },
    });
    return { appeal };
  });

  app.get("/appeals", async (req) => {
    const wallet = authenticatedAddress(req.headers);
    if (!wallet) {
      return { items: [], note: "Provide X-Wallet-Address to list your appeals" };
    }
    const user = await prisma.user.findUnique({ where: { walletAddress: wallet } });
    if (!user) return { items: [] };
    const items = await prisma.appeal.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
    });
    return { items };
  });
}
