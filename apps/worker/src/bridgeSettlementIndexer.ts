import { prisma } from "@rugkiller/db";
import { observedArcExplorer } from "@rugkiller/shared";

const IRIS = "https://iris-api.circle.com";
const arcObserved = () => observedArcExplorer();
const domains: Record<string, number> = { ethereum: 0, optimism: 2, arbitrum: 3, solana: 5, base: 6 };

export async function runBridgeSettlementIndexer() {
  const rows = await prisma.bridgeTransferRow.findMany({
    where: { status: { not: "arc_mint_confirmed" } },
    orderBy: { lastCheckedAt: "asc" },
    take: 25,
  });
  let confirmed = 0;
  let attested = 0;
  let failed = 0;
  for (const row of rows) {
    const domain = domains[row.sourceChain];
    if (domain == null) continue;
    try {
      const response = await fetch(`${IRIS}/v2/messages/${domain}?transactionHash=${encodeURIComponent(row.sourceTxHash)}`, {
        headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        failed++;
        await prisma.bridgeTransferRow.update({ where: { id: row.id }, data: { statusDetail: `Circle status returned ${response.status}.` } });
        continue;
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
        continue;
      }
      let status = message.status === "complete" ? "attestation_ready" : "waiting_for_circle";
      let detail = message.status === "complete" ? "Circle attestation is complete; destination mint is not independently confirmed yet." : "Circle attestation is pending.";
      if (message.forwardTxHash) {
        const mintResponse = !arcObserved().configured ? null : await fetch(`${arcObserved().apiV2}/transactions/${message.forwardTxHash}`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
        if (mintResponse?.ok) {
          const mint = (await mintResponse.json()) as { status?: string; result?: string };
          if (mint.status === "ok" || mint.result === "success") {
            status = "arc_mint_confirmed";
            detail = `Arc destination mint confirmed: ${message.forwardTxHash}`;
            confirmed++;
          }
        }
      }
      if (status === "attestation_ready") attested++;
      await prisma.bridgeTransferRow.update({ where: { id: row.id }, data: { status, statusDetail: detail } });
    } catch (error) {
      failed++;
      await prisma.bridgeTransferRow.update({
        where: { id: row.id },
        data: { statusDetail: `Settlement check unavailable: ${error instanceof Error ? error.message : String(error)}` },
      });
    }
  }
  // Settlement status we could not read is a gap in the evidence, so a run with
  // failed checks must not be published as a healthy verification pass.
  const healthy = failed === 0;
  const lastError = healthy ? null : `${failed} of ${rows.length} settlement checks could not be read.`;
  await prisma.dataSourceHealth.upsert({
    where: { key: "bridge_settlement" },
    create: {
      key: "bridge_settlement",
      name: "Circle settlement verification",
      healthy,
      lastSuccessAt: healthy ? new Date() : null,
      lastError,
      metaJson: JSON.stringify({ checked: rows.length, confirmed, attested, failed }),
    },
    update: {
      healthy,
      lastSuccessAt: healthy ? new Date() : undefined,
      lastError,
      metaJson: JSON.stringify({ checked: rows.length, confirmed, attested, failed }),
    },
  });
  return { checked: rows.length, confirmed, attested, failed };
}
