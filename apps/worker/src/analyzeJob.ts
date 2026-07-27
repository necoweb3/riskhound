import { analyzeToken } from "@rugkiller/analysis";
import { prisma, jparse, persistAnalysisResult, type AnalysisResultLike } from "@rugkiller/db";
import type { RiskEventSummary } from "@rugkiller/shared";

/**
 * The supporting-evidence set does not depend on the token being analysed, so
 * every job recomputed a byte-identical 500-row scan and sort. Reviewed events
 * change on human timescales, so a short window cannot hide one for long.
 */
const EVENTS_TTL_MS = 60_000;
let cachedEvents: { at: number; events: Promise<RiskEventSummary[]> } | null = null;

async function loadConfirmedRiskEvents(): Promise<RiskEventSummary[]> {
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

  return events.map((e) => ({
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
}

function confirmedRiskEvents(): Promise<RiskEventSummary[]> {
  if (cachedEvents && Date.now() - cachedEvents.at < EVENTS_TTL_MS) return cachedEvents.events;
  const events = loadConfirmedRiskEvents();
  cachedEvents = { at: Date.now(), events };
  // A failed read must not be served as an empty evidence set for the window.
  events.catch(() => {
    if (cachedEvents?.events === events) cachedEvents = null;
  });
  return events;
}

export async function loadRhAndAnalyze(address: string) {
  const rhRiskEvents = await confirmedRiskEvents();

  const result = await analyzeToken({ address, rhRiskEvents });
  const token = await persistAnalysisResult(result as unknown as AnalysisResultLike);

  return { tokenId: token.id, overall: result.report.overall, errors: result.errors };
}
