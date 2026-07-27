import { prisma } from "@rugkiller/db";
import { observedArcExplorer } from "@rugkiller/shared";

const IRIS = "https://iris-api.circle.com";
const arcObserved = () => observedArcExplorer();
const ARC_RPC = () => process.env.OBSERVED_ARC_RPC_URL ?? "https://5042.rpc.thirdweb.com";
const domains: Record<string, number> = { ethereum: 0, optimism: 2, arbitrum: 3, solana: 5, base: 6 };
const HOUR = 3600 * 1000;
/** Circle checks issued together. The rest of the loop is network-bound. */
const CHECK_CONCURRENCY = 5;

type CheckOutcome = { confirmed: boolean; attested: boolean; failed: boolean; unverified: boolean };

/**
 * Did the Arc destination mint execute?
 *
 * `null` means the answer could not be read, which is a gap and not a denial.
 * The observed Arc explorer was decommissioned, so the receipt is read from the
 * node when it is not configured; the chain itself still answers.
 */
async function arcMintSucceeded(txHash: string): Promise<boolean | null> {
  const explorer = arcObserved();
  if (explorer.configured) {
    const response = await fetch(`${explorer.apiV2}/transactions/${txHash}`, {
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (response?.ok) {
      const mint = (await response.json().catch(() => null)) as { status?: string; result?: string } | null;
      if (mint) return mint.status === "ok" || mint.result === "success";
    }
  }
  const response = await fetch(ARC_RPC(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [txHash] }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!response?.ok) return null;
  const body = (await response.json().catch(() => null)) as
    | { result?: { status?: string } | null; error?: unknown }
    | null;
  if (!body || body.error) return null;
  // No receipt yet is a mint that has not been mined, which is a real answer.
  if (!body.result) return false;
  return body.result.status === "0x1";
}

async function checkRow(row: { id: string; sourceChain: string; sourceTxHash: string }): Promise<CheckOutcome> {
  const none = { confirmed: false, attested: false, failed: false, unverified: false };
  const domain = domains[row.sourceChain];
  if (domain == null) return none;
  try {
    const response = await fetch(`${IRIS}/v2/messages/${domain}?transactionHash=${encodeURIComponent(row.sourceTxHash)}`, {
      headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await prisma.bridgeTransferRow.update({ where: { id: row.id }, data: { statusDetail: `Circle status returned ${response.status}.` } });
      return { ...none, failed: true };
    }
    const body = (await response.json()) as {
      messages?: Array<{ status?: string; attestation?: string | null; forwardState?: string | null; forwardTxHash?: string | null }>;
    };
    const message = body.messages?.[0];
    if (!message) {
      // No message for this burn yet is a read gap, not evidence that an
      // attestation was withdrawn, so the row keeps the status it has.
      await prisma.bridgeTransferRow.update({
        where: { id: row.id },
        data: { statusDetail: "Circle has not published a message for this transaction yet." },
      });
      return none;
    }
    let status = message.status === "complete" ? "attestation_ready" : "waiting_for_circle";
    let detail = message.status === "complete" ? "Circle attestation is complete; destination mint is not independently confirmed yet." : "Circle attestation is pending.";
    let unverified = false;
    if (message.forwardTxHash) {
      const minted = await arcMintSucceeded(message.forwardTxHash);
      if (minted == null) {
        // An unreadable destination is a gap in the evidence for this row, so
        // it is stated rather than left looking like a pending attestation.
        unverified = true;
        detail = `Circle forwarded ${message.forwardTxHash}, but the Arc destination mint could not be read to confirm it.`;
      } else if (minted) {
        status = "arc_mint_confirmed";
        detail = `Arc destination mint confirmed: ${message.forwardTxHash}`;
      }
    }
    await prisma.bridgeTransferRow.update({ where: { id: row.id }, data: { status, statusDetail: detail } });
    return {
      confirmed: status === "arc_mint_confirmed",
      attested: status === "attestation_ready",
      failed: false,
      unverified,
    };
  } catch (error) {
    await prisma.bridgeTransferRow.update({
      where: { id: row.id },
      data: { statusDetail: `Settlement check unavailable: ${error instanceof Error ? error.message : String(error)}` },
    });
    return { ...none, failed: true };
  }
}

export async function runBridgeSettlementIndexer() {
  const now = Date.now();
  // A burn still pending after days will not resolve in the next minute. Without
  // this the whole table is re-asked at Circle every 60s forever and a fresh
  // burn waits hours behind history that cannot move.
  const rows = await prisma.bridgeTransferRow.findMany({
    where: {
      status: { not: "arc_mint_confirmed" },
      OR: [
        { observedAt: { gte: new Date(now - 24 * HOUR) } },
        { observedAt: { gte: new Date(now - 7 * 24 * HOUR) }, lastCheckedAt: { lt: new Date(now - HOUR) } },
        { lastCheckedAt: { lt: new Date(now - 24 * HOUR) } },
      ],
    },
    orderBy: { lastCheckedAt: "asc" },
    take: 25,
  });
  let confirmed = 0;
  let attested = 0;
  let failed = 0;
  let unverified = 0;
  let next = 0;
  const runChecks = async () => {
    for (;;) {
      const row = rows[next++];
      if (!row) return;
      const outcome = await checkRow(row);
      if (outcome.confirmed) confirmed++;
      if (outcome.attested) attested++;
      if (outcome.failed) failed++;
      if (outcome.unverified) unverified++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, rows.length) }, runChecks));

  // Settlement status we could not read is a gap in the evidence, so a run with
  // failed checks or unreadable destination mints must not be published as a
  // healthy verification pass.
  const problems = [
    failed ? `${failed} of ${rows.length} settlement checks could not be read.` : null,
    unverified ? `${unverified} Arc destination mints could not be verified onchain.` : null,
  ].filter((part): part is string => part != null);
  const healthy = problems.length === 0;
  const lastError = problems.join(" ") || null;
  await prisma.dataSourceHealth.upsert({
    where: { key: "bridge_settlement" },
    create: {
      key: "bridge_settlement",
      name: "Circle settlement verification",
      healthy,
      lastSuccessAt: healthy ? new Date() : null,
      lastError,
      metaJson: JSON.stringify({ checked: rows.length, confirmed, attested, failed, unverified }),
    },
    update: {
      healthy,
      lastSuccessAt: healthy ? new Date() : undefined,
      lastError,
      metaJson: JSON.stringify({ checked: rows.length, confirmed, attested, failed, unverified }),
    },
  });
  return { checked: rows.length, confirmed, attested, failed, unverified };
}
