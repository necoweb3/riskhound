import { prisma, jparse, jstr, persistEvidenceGraph, persistAutomaticRiskEvents } from "@rugkiller/db";
import type { AnalyzeTokenResult } from "@rugkiller/analysis";
import type { RiskEventSummary } from "@rugkiller/shared";

export async function persistAnalysis(result: AnalyzeTokenResult) {
  const d = result.detail;
  const existing = await prisma.token.findUnique({
    where: { chain_address: { chain: d.chain, address: d.address } },
  });

  // Never wipe known metadata with nulls from a partial/failed probe
  const name = d.name ?? existing?.name ?? null;
  const symbol = d.symbol ?? existing?.symbol ?? null;
  const decimals = d.decimals ?? existing?.decimals ?? null;
  const totalSupply = d.totalSupply ?? existing?.totalSupply ?? null;
  const deployer = d.deployer ?? existing?.deployer ?? null;
  const deployTxHash = d.deployTxHash ?? existing?.deployTxHash ?? null;
  const owner = d.owner ?? existing?.owner ?? null;
  const standard =
    d.standard && d.standard !== "unknown"
      ? d.standard
      : existing?.standard && existing.standard !== "unknown"
        ? existing.standard
        : d.standard ?? "ERC-20";
  const holderCount = d.holderCount ?? existing?.holderCount ?? null;
  const liquidityUsd = d.liquidityUsd ?? existing?.liquidityUsd ?? null;

  const token = await prisma.token.upsert({
    where: { chain_address: { chain: d.chain, address: d.address } },
    create: {
      chain: d.chain,
      address: d.address,
      name,
      symbol,
      decimals,
      totalSupply,
      standard,
      deployer,
      deployTxHash,
      owner,
      isProxy: d.isProxy,
      isVerified: d.isVerified,
      templateHint: d.templateHint,
      bytecodeHash: d.bytecodeHash,
      liquidityUsd: liquidityUsd ?? undefined,
      holderCount: holderCount ?? undefined,
      isActive: d.isActive ?? undefined,
      overallRisk: d.overallRisk,
      confidence: d.confidence,
      topSignalsJson: jstr(d.topSignals),
      hasRobinhoodLink: d.hasRobinhoodLink,
      analysisUpdatedAt: new Date(),
      lastAnalyzedBlock: result.report.lastBlock != null ? BigInt(result.report.lastBlock) : null,
    },
    update: {
      name,
      symbol,
      decimals,
      totalSupply,
      standard,
      deployer,
      deployTxHash,
      owner,
      isProxy: d.isProxy,
      isVerified: d.isVerified,
      templateHint: d.templateHint ?? existing?.templateHint,
      bytecodeHash: d.bytecodeHash ?? existing?.bytecodeHash,
      liquidityUsd: liquidityUsd ?? undefined,
      holderCount: holderCount ?? undefined,
      isActive: d.isActive ?? undefined,
      overallRisk: d.overallRisk,
      confidence: d.confidence,
      topSignalsJson: jstr(d.topSignals),
      hasRobinhoodLink: d.hasRobinhoodLink,
      analysisUpdatedAt: new Date(),
      lastAnalyzedBlock: result.report.lastBlock != null ? BigInt(result.report.lastBlock) : null,
    },
  });

  await prisma.analysisRun.create({
    data: {
      tokenId: token.id,
      modelVersion: result.report.modelVersion,
      overallRisk: result.report.overall,
      confidence: result.report.confidence,
      reportJson: jstr(result.report),
      lastBlock: result.report.lastBlock != null ? BigInt(result.report.lastBlock) : null,
      dataSources: jstr(result.report.dataSources),
    },
  });

  await prisma.finding.deleteMany({
    where: { tokenId: token.id, source: "automatic" },
  });
  if (result.report.topFindings.length || result.detail.contractFindings.length) {
    const all = [
      ...result.detail.contractFindings,
      ...result.report.topFindings.filter(
        (f) => !result.detail.contractFindings.some((c) => c.id === f.id)
      ),
    ];
    const map = new Map(all.map((f) => [f.id, f]));
    await prisma.finding.createMany({
      data: [...map.values()].map((f) => ({
        tokenId: token.id,
        chain: d.chain,
        category: f.category,
        name: f.name,
        severity: f.severity,
        status: f.status,
        summary: f.summary,
        whyItMatters: f.whyItMatters,
        controllerAddress: f.controllerAddress,
        relatedFunction: f.relatedFunction,
        evidenceJson: jstr(f.evidence),
        source: f.source,
      })),
    });
  }

  if (d.simulation) {
    await prisma.simulationRun.create({
      data: {
        tokenId: token.id,
        canBuy: d.simulation.canBuy,
        canSell: d.simulation.canSell,
        buyTaxBps: d.simulation.buyTaxBps,
        sellTaxBps: d.simulation.sellTaxBps,
        stepsJson: jstr(d.simulation.steps),
        summary: d.simulation.summary,
        method: d.simulation.method,
        dataComplete: d.simulation.dataComplete,
      },
    });
  }

  await prisma.tokenHolder.deleteMany({ where: { tokenId: token.id } });
  if (d.holders.length) {
    await prisma.tokenHolder.createMany({
      data: d.holders.map((h) => ({
        tokenId: token.id,
        address: h.address,
        balance: h.balance,
        pct: h.pct,
        isContract: h.isContract,
        labelsJson: jstr(h.labels),
      })),
    });
  }

  await prisma.liquidityPoolRow.deleteMany({ where: { tokenId: token.id } });
  if (d.pools.length) {
    await prisma.liquidityPoolRow.createMany({
      data: d.pools.map((pool) => ({
        tokenId: token.id,
        poolAddress: pool.address,
        dex: pool.dex,
        token0: pool.token0,
        token1: pool.token1,
        reserve0: pool.reserve0,
        reserve1: pool.reserve1,
        liquidityUsd: pool.liquidityUsd,
        locked: pool.locked,
        lockUntil: pool.lockUntil ? new Date(pool.lockUntil) : null,
        burned: pool.burned,
        rawJson: jstr(pool),
      })),
    });
  }

  await persistEvidenceGraph(result.graph, d.chain);
  await persistAutomaticRiskEvents({
    tokenId: token.id,
    tokenAddress: d.address,
    chain: d.chain,
    findings: result.report.topFindings,
  });
  if (d.bytecodeHash) {
    const reused = await prisma.token.findMany({
      where: { bytecodeHash: d.bytecodeHash, id: { not: token.id } },
      take: 20,
    });
    for (const other of reused) {
      const fingerprint = `${d.chain}:${d.address}:${other.address}:copied_contract`.toLowerCase();
      await prisma.graphEdgeRow.upsert({
        where: { fingerprint },
        create: {
          fingerprint,
          sourceId: d.address,
          targetId: other.address,
          sourceType: "token",
          targetType: "token",
          edgeType: "copied_contract",
          strength: "definitive",
          chain: d.chain,
          confidence: "high",
          evidenceJson: jstr([{ type: "bytecode", chain: d.chain, value: d.bytecodeHash }]),
          label: "identical deployed bytecode",
        },
        update: { evidenceJson: jstr([{ type: "bytecode", chain: d.chain, value: d.bytecodeHash }]) },
      });
    }
  }

  for (const l of d.crossChainLinks) {
    await prisma.crossChainLinkRow.create({
      data: {
        strength: l.strength,
        fromChain: l.fromChain,
        toChain: l.toChain,
        fromAddress: l.fromAddress,
        toAddress: l.toAddress,
        reason: l.reason,
        evidenceJson: jstr(l.evidence),
        relatedEventIdsJson: jstr(l.relatedEventIds),
      },
    });
  }

  if (d.deployer) {
    await prisma.wallet.upsert({
      where: { chain_address: { chain: d.chain, address: d.deployer } },
      create: {
        chain: d.chain,
        address: d.deployer,
        firstSeenAt: d.deployerProfile?.firstSeenAt
          ? new Date(d.deployerProfile.firstSeenAt)
          : null,
        lastSeenAt: d.deployerProfile?.lastSeenAt
          ? new Date(d.deployerProfile.lastSeenAt)
          : null,
        firstFunder: d.deployerProfile?.firstFunder,
        historyLabel: d.deployerProfile?.historyLabel,
        labelsJson: jstr(["deployer"]),
      },
      update: {
        firstFunder: d.deployerProfile?.firstFunder,
        historyLabel: d.deployerProfile?.historyLabel,
      },
    });
  }

  return token;
}

export async function loadRhRiskEventsForAddresses(
  addresses: string[]
): Promise<RiskEventSummary[]> {
  if (!addresses.length) {
    const events = await prisma.riskEvent.findMany({
      // Outside networks are supporting creator-history evidence only. Arc
      // remains the analyzed product surface.
      where: { chain: { not: "arc_testnet" } },
      take: 50,
      orderBy: { occurredAt: "desc" },
    });
    return events.map(mapEvent);
  }
  const lower = addresses.map((a) => a.toLowerCase());
  const events = await prisma.riskEvent.findMany({
    where: { chain: { not: "arc_testnet" } },
    take: 200,
    orderBy: { occurredAt: "desc" },
  });
  return events
    .map(mapEvent)
    .filter((e) => e.addresses.some((a) => lower.includes(a.toLowerCase())));
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
