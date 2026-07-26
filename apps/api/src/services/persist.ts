import { prisma, jparse, persistAnalysisResult, type AnalysisResultLike } from "@rugkiller/db";
import type { AnalyzeTokenResult } from "@rugkiller/analysis";
import type { RiskEventSummary } from "@rugkiller/shared";

/** Shared with the worker so both paths write the same record. */
export async function persistAnalysis(result: AnalyzeTokenResult) {
  return persistAnalysisResult(result as unknown as AnalysisResultLike);
}

export async function loadRhRiskEventsForAddresses(
  addresses: string[]
): Promise<RiskEventSummary[]> {
  const events = await prisma.riskEvent.findMany({
    where: {
      // Outside networks are supporting creator-history evidence only. Arc
      // remains the analyzed product surface.
      chain: { not: "arc_testnet" },
      // Only confirmed events can become a warning, so filtering here keeps
      // the row cap from evicting the events that actually matter.
      manualStatus: "confirmed",
    },
    take: 500,
    orderBy: { occurredAt: "desc" },
  });
  const mapped = events.map(mapEvent);
  if (!addresses.length) return mapped;
  const lower = new Set(addresses.map((a) => a.toLowerCase()));
  return mapped.filter((e) => e.addresses.some((a) => lower.has(a.toLowerCase())));
}

function mapEvent(e: {
  id: string;
  chain: string;
  eventClass: string;
  title: string;
  tokenAddress: string | null;
  addressesJson: string;
  confidence: string;
  autoDetected: boolean;
  manualStatus: string;
  occurredAt: Date;
  evidenceJson: string;
}): RiskEventSummary {
  return {
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
  };
}

export function tokenRowToSummary(t: {
  id: string;
  chain: string;
  address: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupply: string | null;
  standard: string | null;
  deployer: string | null;
  deployTxHash: string | null;
  deployBlock: bigint | null;
  deployTimestamp: Date | null;
  owner: string | null;
  isProxy: boolean;
  isVerified: boolean;
  templateHint: string | null;
  bytecodeHash: string | null;
  firstLiquidityUsd: number | null;
  liquidityUsd: number | null;
  holderCount: number | null;
  isActive: boolean | null;
  overallRisk: string | null;
  confidence: string | null;
  topSignalsJson: string;
  hasRobinhoodLink: boolean;
  analysisUpdatedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: t.id,
    chain: t.chain,
    address: t.address,
    name: t.name,
    symbol: t.symbol,
    decimals: t.decimals,
    totalSupply: t.totalSupply,
    standard: t.standard,
    deployer: t.deployer,
    deployTxHash: t.deployTxHash,
    deployBlock: t.deployBlock != null ? Number(t.deployBlock) : null,
    deployTimestamp: t.deployTimestamp?.toISOString() ?? null,
    owner: t.owner,
    isProxy: t.isProxy,
    isVerified: t.isVerified,
    templateHint: t.templateHint,
    bytecodeHash: t.bytecodeHash,
    firstLiquidityUsd: t.firstLiquidityUsd,
    liquidityUsd: t.liquidityUsd,
    holderCount: t.holderCount,
    isActive: t.isActive,
    overallRisk: t.overallRisk as never,
    confidence: t.confidence as never,
    topSignals: jparse<string[]>(t.topSignalsJson, []),
    hasRobinhoodLink: t.hasRobinhoodLink,
    analysisUpdatedAt: t.analysisUpdatedAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
  };
}
