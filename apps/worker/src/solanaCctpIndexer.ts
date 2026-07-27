import { prisma } from "@rugkiller/db";
import { observedArcExplorer } from "@rugkiller/shared";

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

type IngestResult = "ingested" | "skipped" | "failed";

async function ingest(signature: Signature): Promise<IngestResult> {
  if (signature.err) return "skipped";
  const response = await fetch(`${IRIS}/v2/messages/5?transactionHash=${encodeURIComponent(signature.signature)}`, {
    headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000),
  });
  // 404 is Circle answering that this signature carries no CCTP message, which
  // is true of most of this program's traffic (receives, not burns). Only a
  // failure to get an answer at all is unread; treating 404 as unread would
  // hold the backfill cursor on the first non-burn signature forever.
  if (response.status === 404) return "skipped";
  // A non-OK Circle response says nothing about this signature, so it is an
  // unread signature rather than one that can be skipped.
  if (!response.ok) return "failed";
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
  if (!message) return "skipped";
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
      recipientArcExplorerUrl: observedArcExplorer().addressUrl(recipient),
      observedAt: new Date((signature.blockTime ?? Math.floor(Date.now() / 1000)) * 1000),
    },
    update: {},
  });
  if (message.status === "complete") {
    // Never walk a row back from a mint that settlement verification already
    // confirmed onchain; attestation_ready is the weaker claim of the two.
    await prisma.bridgeTransferRow.updateMany({
      where: { sourceTxHash: signature.signature, status: { not: "arc_mint_confirmed" } },
      data: { status: "attestation_ready" },
    });
  }
  return "ingested";
}

/**
 * Circle indexes a confirmed signature within minutes, so "no message" only
 * becomes a final answer once the signature is past this window. Before that it
 * is a race with Circle's own indexer and has to be asked again.
 */
const RESOLVE_GRACE_MS = 15 * 60 * 1000;

/**
 * May a signature Circle had no message for be retired from the rotation?
 *
 * A failed transaction can never carry a burn. Anything else is only final once
 * Circle has had time to index it, and a signature the ledger has not
 * timestamped yet is the newest kind there is, so it cannot have outlived that
 * window. Retiring it is permanent, so an unknown blockTime has to mean no.
 */
export function canRetireSignature(signature: Signature, now = Date.now()) {
  if (signature.err) return true;
  if (signature.blockTime == null) return false;
  return now - signature.blockTime * 1000 >= RESOLVE_GRACE_MS;
}

/** How many settled signatures to carry in the cursor. */
const RESOLVED_MEMORY = 500;
/** Circle lookups in flight at once. The loop is entirely network-bound. */
const CIRCLE_CONCURRENCY = 5;

export async function runSolanaCctpIndexer() {
  const cursorRow = await prisma.indexerCursor.findUnique({ where: { key: "solana_cctp_backfill" } });
  const meta = (cursorRow?.metaJson ? JSON.parse(cursorRow.metaJson) : {}) as { before?: string; resolved?: unknown };
  const before = meta.before;
  const resolved = new Set<string>(Array.isArray(meta.resolved) ? (meta.resolved as string[]) : []);
  const [recent, historical] = await Promise.all([
    rpc("getSignaturesForAddress", [PROGRAM, { limit: 20, commitment: "confirmed" }]) as Promise<Signature[]>,
    rpc("getSignaturesForAddress", [PROGRAM, { limit: 40, commitment: "confirmed", ...(before ? { before } : {}) }]) as Promise<Signature[]>,
  ]);
  const unique = [...new Map([...recent, ...historical].map((item) => [item.signature, item])).values()];
  // The newest signatures barely move between polls, so most of this page was
  // being re-asked at Circle every two minutes for an answer already had.
  const pending = unique.filter((item) => !resolved.has(item.signature));
  let matched = 0;
  const unread = new Set<string>();
  let next = 0;
  const drain = async () => {
    for (;;) {
      const signature = pending[next++];
      if (!signature) return;
      const result = await ingest(signature);
      // An ingested signature keeps being re-read: its Circle status can still
      // move from pending to complete, and only a re-read would show that.
      if (result === "ingested") matched++;
      else if (result === "failed") unread.add(signature.signature);
      else if (canRetireSignature(signature)) resolved.add(signature.signature);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CIRCLE_CONCURRENCY, pending.length) }, drain));
  // Keep signatures still being shown at the fresh end, so the cap evicts old
  // history rather than the page that is re-read on every tick.
  for (const item of unique) if (resolved.delete(item.signature)) resolved.add(item.signature);
  const nextResolved = [...resolved].slice(-RESOLVED_MEMORY);

  // Moving `before` past a signature Circle would not answer for drops it from
  // the backfill permanently, so hold the cursor until the page reads cleanly.
  const historyIncomplete = historical.some((item) => unread.has(item.signature));
  const nextBefore = historyIncomplete ? before ?? null : historical.at(-1)?.signature ?? before ?? null;
  await prisma.indexerCursor.upsert({
    where: { key: "solana_cctp_backfill" },
    create: { key: "solana_cctp_backfill", lastAt: new Date(), metaJson: JSON.stringify({ before: nextBefore, resolved: nextResolved }) },
    update: { lastAt: new Date(), metaJson: JSON.stringify({ before: nextBefore, resolved: nextResolved }) },
  });
  // Signatures Circle would not answer for are burns we cannot see, so a run
  // holding any of them is not a clean pass over the source.
  const healthy = unread.size === 0;
  const lastError = healthy ? null : `${unread.size} of ${pending.length} signatures could not be read from Circle.`;
  await prisma.dataSourceHealth.upsert({
    where: { key: "solana_cctp" },
    create: { key: "solana_cctp", name: "Solana CCTP V2", healthy, lastSuccessAt: healthy ? new Date() : null, lastError, metaJson: JSON.stringify({ seen: unique.length, checked: pending.length, matched, unread: unread.size }) },
    update: { healthy, lastSuccessAt: healthy ? new Date() : undefined, lastError, metaJson: JSON.stringify({ seen: unique.length, checked: pending.length, matched, unread: unread.size }) },
  });
  return { checked: pending.length, matched, unread: unread.size };
}
