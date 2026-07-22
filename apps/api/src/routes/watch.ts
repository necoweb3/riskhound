import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma, jparse } from "@rugkiller/db";
import { normalizeAddress } from "@rugkiller/chain";
import { authenticatedAddress } from "../services/auth.js";

async function ensureUser(wallet: string) {
  return prisma.user.upsert({
    where: { walletAddress: wallet.toLowerCase() },
    create: { walletAddress: wallet.toLowerCase() },
    update: {},
  });
}

export async function watchRoutes(app: FastifyInstance) {
  app.get("/watchlist", async (req, reply) => {
    const wallet = authenticatedAddress(req.headers);
    if (!wallet || !normalizeAddress(wallet)) {
      return reply.code(401).send({ error: "wallet_required", message: "Provide X-Wallet-Address header" });
    }
    const user = await ensureUser(wallet);
    const items = await prisma.watchlistItem.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
    });
    return { items };
  });

  app.post("/watchlist", async (req, reply) => {
    const wallet = authenticatedAddress(req.headers);
    if (!wallet || !normalizeAddress(wallet)) {
      return reply.code(401).send({ error: "wallet_required" });
    }
    const body = z
      .object({
        entityType: z.enum(["token", "wallet"]),
        chain: z.string().default("arc_testnet"),
        address: z.string(),
      })
      .parse(req.body);
    const addr = normalizeAddress(body.address);
    if (!addr) return reply.code(400).send({ error: "invalid_address" });
    const user = await ensureUser(wallet);
    const item = await prisma.watchlistItem.upsert({
      where: {
        userId_entityType_chain_address: {
          userId: user.id,
          entityType: body.entityType,
          chain: body.chain,
          address: addr.toLowerCase(),
        },
      },
      create: {
        userId: user.id,
        entityType: body.entityType,
        chain: body.chain,
        address: addr.toLowerCase(),
      },
      update: {},
    });
    return { item };
  });

  app.delete("/watchlist/:id", async (req, reply) => {
    const wallet = authenticatedAddress(req.headers);
    if (!wallet) return reply.code(401).send({ error: "wallet_required" });
    const user = await ensureUser(wallet);
    const { id } = req.params as { id: string };
    await prisma.watchlistItem.deleteMany({ where: { id, userId: user.id } });
    return { ok: true };
  });

  app.get("/alerts", async (req, reply) => {
    const wallet = authenticatedAddress(req.headers);
    if (!wallet) return reply.code(401).send({ error: "wallet_required" });
    const user = await ensureUser(wallet);
    const items = await prisma.alert.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return {
      items: items.map((a) => ({
        ...a,
        evidence: jparse(a.evidenceJson, []),
        createdAt: a.createdAt.toISOString(),
      })),
    };
  });

  app.post("/alerts/read", async (req, reply) => {
    const wallet = authenticatedAddress(req.headers);
    if (!wallet) return reply.code(401).send({ error: "wallet_required" });
    const user = await ensureUser(wallet);
    const body = z.object({ ids: z.array(z.string()).optional() }).parse(req.body ?? {});
    await prisma.alert.updateMany({
      where: body.ids?.length
        ? { userId: user.id, id: { in: body.ids } }
        : { userId: user.id },
      data: { read: true },
    });
    return { ok: true };
  });
}
