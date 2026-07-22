import { getPaymentNetwork, loadNetworksFromEnv, priceFor, type PaidFeature } from "@rugkiller/shared";

export const config = {
  port: Number(process.env.PORT ?? process.env.API_PORT ?? 4000),
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:3000",
  publicUrl: process.env.API_PUBLIC_URL ?? "http://localhost:4000",
  webUrl: process.env.WEB_PUBLIC_URL ?? "http://localhost:3000",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  jwtSecret: process.env.JWT_SECRET ?? "dev-only-change-me",
  adminWallets: (process.env.ADMIN_WALLETS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  freeAnalysesPerDay: Number(process.env.FREE_ANALYSES_PER_DAY ?? 10),
  freeRpm: Number(process.env.FREE_API_REQUESTS_PER_MINUTE ?? 30),
  x402Enabled: (process.env.X402_ENABLED ?? "true") === "true",
  x402Facilitator: process.env.X402_FACILITATOR_URL ?? "https://x402.org/facilitator",
  paymentRecipient: process.env.PAYMENT_RECIPIENT_ADDRESS ?? "0x0000000000000000000000000000000000000000",
  riskModelVersion: process.env.RISK_MODEL_VERSION ?? "1.0.0",
  networks: loadNetworksFromEnv(),
  paymentNetwork: getPaymentNetwork(),
  price: (f: PaidFeature) => priceFor(f),
};

export function validateProductionConfig() {
  if (process.env.NODE_ENV !== "production") return;

  if (config.jwtSecret === "dev-only-change-me" || config.jwtSecret === "change-me-to-a-long-random-string") {
    throw new Error("JWT_SECRET must be set to a strong, unique value in production.");
  }

  if (!config.adminWallets.length) {
    throw new Error("ADMIN_WALLETS must contain at least one reviewer wallet in production.");
  }

  if (
    config.x402Enabled &&
    /^0x0{40}$/i.test(config.paymentRecipient)
  ) {
    throw new Error("PAYMENT_RECIPIENT_ADDRESS must be set before x402 is enabled in production.");
  }
}
