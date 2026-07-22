import { randomUUID } from "node:crypto";
import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";
import { parseUnits } from "viem";
import { prisma, jstr } from "@rugkiller/db";
import type { ApiQuote } from "@rugkiller/shared";
import { FEATURE_META, type PaidFeature } from "@rugkiller/shared";
import { config } from "../config.js";

function paymentSettings() {
  const paymentNetwork = config.paymentNetwork;
  if (!paymentNetwork.usdcAddress) {
    throw new Error(`USDC is not configured for payment network ${paymentNetwork.key}.`);
  }
  return {
    key: paymentNetwork.key,
    name: paymentNetwork.name,
    chainId: paymentNetwork.chainId,
    network: `eip155:${paymentNetwork.chainId}`,
    asset: paymentNetwork.usdcAddress,
    facilitator: config.x402Facilitator,
  };
}

type PaymentPayload = {
  x402Version: number;
  accepted?: { network?: string; scheme?: string; asset?: string; amount?: string; payTo?: string };
  payload: Record<string, unknown>;
  resource?: { url: string; description: string; mimeType: string };
};

function recipient() {
  const address = config.paymentRecipient;
  return /^0x[a-fA-F0-9]{40}$/.test(address) && !/^0x0{40}$/i.test(address) ? address : null;
}

function amountAtomic(feature: PaidFeature) {
  return parseUnits(config.price(feature), 6).toString();
}

async function requirements(feature: PaidFeature) {
  const payTo = recipient();
  if (!payTo) throw new Error("PAYMENT_RECIPIENT_ADDRESS is not configured.");
  const payment = paymentSettings();
  const client = new BatchFacilitatorClient({ url: payment.facilitator });
  const supported = await client.getSupported();
  const kind = supported.kinds.find((candidate) => candidate.network === payment.network);
  const verifyingContract = kind?.extra?.verifyingContract;
  const advertisedAssets = Array.isArray(kind?.extra?.assets)
    ? (kind.extra.assets as Array<{ address: string }>)
    : [];
  const advertisedAsset = advertisedAssets.find(
    (candidate) => candidate.address.toLowerCase() === payment.asset.toLowerCase()
  );
  if (!verifyingContract || !advertisedAsset) {
    throw new Error(`Circle Gateway did not advertise ${payment.name} USDC support.`);
  }
  return {
    client,
    value: {
      scheme: "exact",
      network: payment.network,
      asset: payment.asset,
      amount: amountAtomic(feature),
      payTo,
      maxTimeoutSeconds: 604_900,
      extra: { name: "GatewayWalletBatched", version: "1", verifyingContract },
    },
  };
}

function decodePayment(header: string, feature: PaidFeature) {
  if (header.length > 32_768) throw new Error("Payment payload is too large.");
  const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as PaymentPayload;
  const payTo = recipient();
  const payment = paymentSettings();
  if (
    decoded.x402Version !== 2 ||
    decoded.accepted?.network !== payment.network ||
    decoded.accepted?.scheme !== "exact" ||
    decoded.accepted.asset?.toLowerCase() !== payment.asset.toLowerCase() ||
    decoded.accepted.amount !== amountAtomic(feature) ||
    decoded.accepted.payTo?.toLowerCase() !== payTo?.toLowerCase()
  ) {
    throw new Error("Payment payload does not match the server-authored network, price, asset, or recipient.");
  }
  return decoded;
}

export function buildQuote(feature: PaidFeature, maxSpendUsdc?: string): ApiQuote {
  const price = config.price(feature);
  const payment = paymentSettings();
  return {
    endpoint: feature,
    priceUsdc: price,
    network: payment.key,
    chainId: payment.chainId,
    recipient: recipient() ?? "",
    asset: payment.asset,
    maxSpendUsdc: maxSpendUsdc ?? price,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  };
}

export async function paymentRequiredHeader(feature: PaidFeature, url: string) {
  const { value } = await requirements(feature);
  return Buffer.from(JSON.stringify({
    x402Version: 2,
    resource: { url, description: FEATURE_META[feature].description, mimeType: "application/json" },
    accepts: [value],
  })).toString("base64");
}

export async function verifyPayment(feature: PaidFeature, header: string): Promise<void> {
  const decoded = decodePayment(header, feature);
  const { client, value } = await requirements(feature);
  const verified = await client.verify(decoded as never, value as never);
  if (!verified.isValid) throw new Error(verified.invalidReason ?? "Payment verification failed.");
}

export async function settleVerifiedPayment(input: {
  feature: PaidFeature;
  requestId: string;
  header: string;
  payerAddress?: string;
}) {
  const decoded = decodePayment(input.header, input.feature);
  const { client, value } = await requirements(input.feature);
  const settled = await client.settle(decoded as never, value as never);
  if (!settled.success) throw new Error(settled.errorReason ?? "Payment settlement failed.");
  const payment = paymentSettings();
  return prisma.payment.upsert({
    where: { requestId: input.requestId },
    create: {
      requestId: input.requestId,
      feature: input.feature,
      amountUsdc: config.price(input.feature),
      network: payment.key,
      chainId: payment.chainId,
      status: "settled",
      txHash: settled.transaction,
      payerAddress: input.payerAddress?.toLowerCase(),
      settledAt: new Date(),
      payloadJson: jstr(settled),
    },
    update: { status: "settled", txHash: settled.transaction, settledAt: new Date(), payloadJson: jstr(settled) },
  });
}

export function newRequestId() {
  return randomUUID();
}

export function featureCatalog() {
  const payment = paymentSettings();
  return Object.entries(FEATURE_META).map(([key, meta]) => ({
    feature: key,
    ...meta,
    priceUsdc: config.price(key as PaidFeature),
    paymentNetwork: payment.key,
    paymentChainId: payment.chainId,
  }));
}
