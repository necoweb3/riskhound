import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createWalletChallenge, verifyWalletChallenge } from "../services/auth.js";

export async function authRoutes(app: FastifyInstance) {
  app.get("/auth/challenge", async (req, reply) => {
    const { address } = z.object({ address: z.string() }).parse(req.query);
    try {
      return createWalletChallenge(address);
    } catch {
      return reply.code(400).send({ error: "invalid_address" });
    }
  });

  app.post("/auth/verify", async (req, reply) => {
    const body = z.object({
      challenge: z.string().max(4096),
      message: z.string().max(4096),
      signature: z.string().regex(/^0x[a-fA-F0-9]+$/),
    }).parse(req.body);
    const result = await verifyWalletChallenge(body as { challenge: string; message: string; signature: `0x${string}` });
    if (!result) return reply.code(401).send({ error: "invalid_signature" });
    return result;
  });
}
