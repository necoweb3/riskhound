import { prisma } from "@rugkiller/db";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const IRIS = "https://iris-api.circle.com";
const PROGRAM = "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe";
const SOLSCAN = "https://solscan.io";

type Signature = { signature: string; blockTime?: number | null; err?: unknown };

export function normalizeArcRecipient(value?: string | null) {
  if (!value) return "unknown";
  const normalized = value.toLowerCase();
  if (/^0x[0-9a-f]{64}$/.test(normalized)) return `0x${normalized.slice(-40)}`;
  return /^0x[0-9a-f]{40}$/.test(normalized) ? normalized : "unknown";
}

async function rpc(method: string, params: unknown[]) {
  const response = await fetch(RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Solana RPC returned ${response.status}`);
  const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? "Solana RPC error");
  return body.result;
}

async function ingest(signature: Signature) {
  if (signature.err) return false;
  const response = await fetch(`${IRIS}/v2/messages/5?transactionHash=${encodeURIComponent(signature.signature)}`, {
    headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return false;
  const body = (await response.json()) as {
    messages?: Array<{
      status?: string;
      forwardTxHash?: string | null;
      decodedMessage?: {
        destinationDomain?: string;
        sender?: string;
        decodedMessageBody?: { mintRecipient?: string; amount?: string; messageSender?: string };
      };
    }>;
  };
  const message = body.messages?.find((item) => item.decodedMessage?.destinationDomain === "26");
  if (!message) return false;
  const decoded = message.decodedMessage;
  const recipient = normalizeArcRecipient(decoded?.decodedMessageBody?.mintRecipient);
  const amountUsdc = Number(decoded?.decodedMessageBody?.amount ?? 0) / 1_000_000;
  await prisma.bridgeTransferRow.upsert({
    where: { sourceTxHash: signature.signature },
    create: {
      sourceChain: "solana", destinationChain: "arc_observed_5042", sourceTxHash: signature.signature,
      sender: decoded?.decodedMessageBody?.messageSender || decoded?.sender || "unknown", recipient, amountUsdc,
      status: message.status === "complete" ? "attestation_ready" : "waiting_for_circle",
      statusDetail: message.status === "complete" ? "Circle attestation complete; Arc mint verification queued." : "Solana burn observed; Circle attestation pending.",
      sourceExplorerUrl: `${SOLSCAN}/tx/${signature.signature}`,
      recipientArcExplorerUrl: `https://megaeth-pump-ok-moon.poptyedev.com/address/${recipient}`,
      observedAt: new Date((signature.blockTime ?? Math.floor(Date.now() / 1000)) * 1000),
    },
    update: { status: message.status === "complete" ? "attestation_ready" : undefined },
  });
  return true;
}

export async function runSolanaCctpIndexer() {
  const cursorRow = await prisma.indexerCursor.findUnique({ where: { key: "solana_cctp_backfill" } });
  const before = cursorRow?.metaJson ? JSON.parse(cursorRow.metaJson).before as string | undefined : undefined;
  const [recent, historical] = await Promise.all([
    rpc("getSignaturesForAddress", [PROGRAM, { limit: 20, commitment: "confirmed" }]) as Promise<Signature[]>,
    rpc("getSignaturesForAddress", [PROGRAM, { limit: 40, commitment: "confirmed", ...(before ? { before } : {}) }]) as Promise<Signature[]>,
  ]);
  const unique = [...new Map([...recent, ...historical].map((item) => [item.signature, item])).values()];
  let matched = 0;
  for (const signature of unique) if (await ingest(signature)) matched++;
  const nextBefore = historical.at(-1)?.signature ?? before ?? null;
  await prisma.indexerCursor.upsert({
    where: { key: "solana_cctp_backfill" },
    create: { key: "solana_cctp_backfill", lastAt: new Date(), metaJson: JSON.stringify({ before: nextBefore }) },
    update: { lastAt: new Date(), metaJson: JSON.stringify({ before: nextBefore }) },
  });
  await prisma.dataSourceHealth.upsert({
    where: { key: "solana_cctp" },
    create: { key: "solana_cctp", name: "Solana CCTP V2", healthy: true, lastSuccessAt: new Date(), metaJson: JSON.stringify({ checked: unique.length, matched }) },
    update: { healthy: true, lastSuccessAt: new Date(), lastError: null, metaJson: JSON.stringify({ checked: unique.length, matched }) },
  });
  return { checked: unique.length, matched };
}
