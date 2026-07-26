import { analyzeToken } from "@rugkiller/analysis";
import { prisma, jparse, persistAnalysisResult, type AnalysisResultLike } from "@rugkiller/db";
import type { RiskEventSummary } from "@rugkiller/shared";

export async function loadRhAndAnalyze(address: string) {
  const events = await prisma.riskEvent.findMany({
    where: {
      chain: { not: "arc_testnet" },
      // Only confirmed events can become a warning downstream, so the cap
      // never evicts an event that would have mattered.
      manualStatus: "confirmed",
    },
    orderBy: { occurredAt: "desc" },
    take: 500,
  });

  const rhRiskEvents: RiskEventSummary[] = events.map((e) => ({
    id: e.id,
    chain: e.chain,
    eventClass: e.eventClass as RiskEventSummary["eventClass"],
    title: e.title,
    tokenAddress: e.tokenAddress ?? undefined,
    addresses: jparse<string[]>(e.addressesJson, []),
    confidence: e.confidence as RiskEventSummary["confidence"],
    autoDetected: e.autoDetected,
    manualStatus: e.manualStatus as RiskEventSummary["manualStatus"],
    occurredAt: e.occurredAt.toISOString(),
    evidence: jparse(e.evidenceJson, []),
  }));

  const result = await analyzeToken({ address, rhRiskEvents });
  const token = await persistAnalysisResult(result as unknown as AnalysisResultLike);

  return { tokenId: token.id, overall: result.report.overall, errors: result.errors };
}
