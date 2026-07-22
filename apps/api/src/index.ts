import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { config, validateProductionConfig } from "./config.js";
import { initQueues, isRedisUp } from "./queue.js";
import { tokenRoutes } from "./routes/tokens.js";
import { walletRoutes } from "./routes/wallets.js";
import { eventRoutes } from "./routes/events.js";
import { watchRoutes } from "./routes/watch.js";
import { appealRoutes } from "./routes/appeals.js";
import { adminRoutes } from "./routes/admin.js";
import { paidRoutes } from "./routes/paid.js";
import { metaRoutes } from "./routes/meta.js";
import { graphRoutes } from "./routes/graph.js";
import { authRoutes } from "./routes/auth.js";
import { bridgeRoutes } from "./routes/bridge.js";
import { observedMainnetRoutes } from "./routes/observed-mainnet.js";

async function main() {
  validateProductionConfig();

  await initQueues().catch((e) => {
    if (process.env.REDIS_OPTIONAL === "true") {
      console.warn("[api] continuing without Redis", e instanceof Error ? e.message : e);
    } else {
      throw e;
    }
  });

  // JSON.stringify cannot serialize BigInt by default
  (BigInt.prototype as unknown as { toJSON?: () => string }).toJSON = function toJSON() {
    return this.toString();
  };

  const app = Fastify({
    logger: true,
    bodyLimit: 1_048_576,
    trustProxy: process.env.NODE_ENV === "production",
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (process.env.NODE_ENV === "production") {
      reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    return payload;
  });

  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin || origin === config.corsOrigin) return callback(null, true);
      if (process.env.NODE_ENV !== "production" && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Origin is not allowed"), false);
    },
    exposedHeaders: [
      "X-Payment-Required",
      "X-Payment-Network",
      "X-Payment-Chain-Id",
      "X-Payment-Asset",
      "X-Payment-Amount",
      "X-Payment-Recipient",
      "X-Payment-Request-Id",
      "X-Payment-Expires",
      "X-Payment-Max-Spend",
    ],
  });

  await app.register(rateLimit, {
    max: config.freeRpm,
    timeWindow: "1 minute",
  });

  app.setErrorHandler((err, _req, reply) => {
    app.log.error(err);
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    const message =
      err instanceof Error
        ? err.message
        : typeof err === "string"
          ? err
          : "Unexpected error";
    reply.code(status).send({
      error: err instanceof Error ? err.name : "error",
      message,
    });
  });

  await app.register(metaRoutes);
  await app.register(bridgeRoutes);
  await app.register(observedMainnetRoutes);
  await app.register(graphRoutes);
  await app.register(authRoutes);
  await app.register(tokenRoutes);
  await app.register(walletRoutes);
  await app.register(eventRoutes);
  await app.register(watchRoutes);
  await app.register(appealRoutes);
  await app.register(adminRoutes);
  await app.register(paidRoutes);

  app.get("/", async () => ({
    name: "RiskHound API",
    version: "0.1.0",
    redis: isRedisUp(),
    docs: `${config.publicUrl}/methodology`,
    agent: `${config.publicUrl}/v1/agent/query`,
    pricing: `${config.publicUrl}/v1/pricing`,
  }));

  await app.listen({ port: config.port, host: "0.0.0.0" });
  console.log(`RiskHound API on :${config.port} (redis=${isRedisUp()})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
