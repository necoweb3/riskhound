import { analyzeToken } from "@rugkiller/analysis";
import { prisma, jparse, jstr, persistEvidenceGraph, persistAutomaticRiskEvents } from "@rugkiller/db";
import type { RiskEventSummary } from "@rugkiller/shared";

export async function loadRhAndAnalyze(address: string) {
  const events = await prisma.riskEvent.findMany({
    where: { chain: { not: "arc_testnet" } },
    orderBy: { occurredAt: "desc" },
    take: 200,
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

  const d = result.detail;
  const existing = await prisma.token.findUnique({
    where: { chain_address: { chain: d.chain, address: d.address } },
  });

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
        : "ERC-20";

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
      liquidityUsd: d.liquidityUsd ?? existing?.liquidityUsd ?? undefined,
      holderCount: d.holderCount ?? existing?.holderCount ?? undefined,
      isActive: d.isActive ?? undefined,
      overallRisk: d.overallRisk,
      confidence: d.confidence,
      topSignalsJson: jstr(d.topSignals),
      hasRobinhoodLink: d.hasRobinhoodLink,
      analysisUpdatedAt: new Date(),
      lastAnalyzedBlock:
        result.report.lastBlock != null ? BigInt(result.report.lastBlock) : null,
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
      liquidityUsd: d.liquidityUsd ?? existing?.liquidityUsd ?? undefined,
      holderCount: d.holderCount ?? existing?.holderCount ?? undefined,
      isActive: d.isActive ?? undefined,
      overallRisk: d.overallRisk,
      confidence: d.confidence,
      topSignalsJson: jstr(d.topSignals),
      hasRobinhoodLink: d.hasRobinhoodLink,
      analysisUpdatedAt: new Date(),
      lastAnalyzedBlock:
        result.report.lastBlock != null ? BigInt(result.report.lastBlock) : null,
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

  await prisma.finding.deleteMany({ where: { tokenId: token.id, source: "automatic" } });
  const findings = result.report.topFindings;
  if (findings.length) {
    await prisma.finding.createMany({
      data: findings.map((f) => ({
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
        source: "automatic",
      })),
    });
  }

  // Replace holders snapshot
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
  await persistAutomaticRiskEvents({ tokenId: token.id, tokenAddress: d.address, chain: d.chain, findings: result.report.topFindings });
  if (d.bytecodeHash) {
    const reused = await prisma.token.findMany({ where: { bytecodeHash: d.bytecodeHash, id: { not: token.id } }, take: 20 });
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

  return { tokenId: token.id, overall: result.report.overall, errors: result.errors };
}
