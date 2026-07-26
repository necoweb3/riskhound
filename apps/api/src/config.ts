import { randomBytes } from "node:crypto";
import { loadNetworksFromEnv } from "@rugkiller/shared";

const PLACEHOLDER_SECRETS = new Set(["dev-only-change-me", "change-me-to-a-long-random-string", ""]);

/**
 * Session tokens are HMACs over this secret and admin access is granted from
 * the address inside them, so a known secret means anyone can mint an admin
 * session. validateProductionConfig only runs when NODE_ENV happens to be
 * "production", which is one missing env var away from shipping the published
 * placeholder. Fail closed instead: an unset secret becomes a random one, so
 * existing tokens stop validating on restart but nothing is forgeable.
 */
function resolveJwtSecret() {
  const configured = process.env.JWT_SECRET?.trim() ?? "";
  if (!PLACEHOLDER_SECRETS.has(configured)) return configured;
  console.warn(
    "[config] JWT_SECRET is unset or still the placeholder. Using a random per-process secret; sessions will not survive a restart."
  );
  return randomBytes(48).toString("base64url");
}

export const config = {
  port: Number(process.env.PORT ?? process.env.API_PORT ?? 4000),
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:3000",
  publicUrl: process.env.API_PUBLIC_URL ?? "http://localhost:4000",
  webUrl: process.env.WEB_PUBLIC_URL ?? "http://localhost:3000",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  jwtSecret: resolveJwtSecret(),
  adminWallets: (process.env.ADMIN_WALLETS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  freeAnalysesPerDay: Number(process.env.FREE_ANALYSES_PER_DAY ?? 10),
  freeRpm: Number(process.env.FREE_API_REQUESTS_PER_MINUTE ?? 30),
  riskModelVersion: process.env.RISK_MODEL_VERSION ?? "1.0.0",
  networks: loadNetworksFromEnv(),
};

export function validateProductionConfig() {
  if (process.env.NODE_ENV !== "production") return;

  const configured = process.env.JWT_SECRET?.trim() ?? "";
  if (PLACEHOLDER_SECRETS.has(configured) || configured.length < 32) {
    throw new Error("JWT_SECRET must be set to a strong, unique value of at least 32 characters in production.");
  }

  if (!config.adminWallets.length) {
    throw new Error("ADMIN_WALLETS must contain at least one reviewer wallet in production.");
  }

}
