import { prisma } from "./index.js";
import { jstr } from "./json.js";
import { persistEvidenceGraph, persistAutomaticRiskEvents } from "./evidence.js";

/**
 * Structural shape of an analysis result. Typed inline so this package stays
 * free of a dependency on the analysis package, matching evidence.ts.
 */
type Finding = {
  id: string;
  category: string;
  name: string;
  severity: string;
  status: string;
  summary: string;
  whyItMatters: string;
  controllerAddress?: string;
  relatedFunction?: string;
  evidence: unknown[];
  source: string;
};

export type AnalysisResultLike = {
  detail: {
    chain: string;
    address: string;
    name: string | null;
    symbol: string | null;
    decimals: number | null;
    totalSupply: string | null;
    standard: string | null;
    deployer: string | null;
    deployTxHash: string | null;
    owner: string | null;
    isProxy: boolean;
    isVerified: boolean;
    templateHint: string | null;
    bytecodeHash: string | null;
    liquidityUsd: number | null;
    holderCount: number | null;
    isActive: boolean | null;
    overallRisk: string;
    confidence: string;
    topSignals: string[];
    hasRobinhoodLink: boolean;
    contractFindings: Finding[];
    simulation: {
      canBuy: boolean | null;
      canSell: boolean | null;
      buyTaxBps: number | null;
      sellTaxBps: number | null;
      steps: unknown[];
      summary: string;
      method: string;
      dataComplete: boolean;
    } | null;
    holders: { address: string; balance: string; pct: number | null; isContract: boolean; labels: unknown[] }[];
    pools: {
      address: string;
      dex: string;
      token0: string;
      token1: string;
      reserve0: string;
      reserve1: string;
      liquidityUsd: number | null;
      locked: boolean;
      lockUntil?: string | null;
      burned: boolean;
    }[];
    crossChainLinks: {
      id: string;
      strength: string;
      fromChain: string;
      toChain: string;
      fromAddress: string;
      toAddress: string;
      reason: string;
      evidence: unknown[];
      relatedEventIds: string[];
    }[];
    deployerProfile: {
      firstSeenAt?: string | null;
      lastSeenAt?: string | null;
      firstFunder?: string | null;
      historyLabel?: string | null;
    } | null;
  };
  report: {
    modelVersion: string;
    overall: string;
    confidence: string;
    topFindings: Finding[];
    lastBlock: number | null;
    dataSources: unknown[];
  };
  graph: Parameters<typeof persistEvidenceGraph>[0];
};

/**
 * Single writer for an analysis result. The worker and the paid API both call
 * this, so a token's stored record does not depend on which path analysed it.
 */
export async function persistAnalysisResult(result: AnalysisResultLike) {
  const d = result.detail;
  const existing = await prisma.token.findUnique({
    where: { chain_address: { chain: d.chain, address: d.address } },
  });

  // Never wipe known metadata with nulls from a partial or failed probe.
  const carried = {
    name: d.name ?? existing?.name ?? null,
    symbol: d.symbol ?? existing?.symbol ?? null,
    decimals: d.decimals ?? existing?.decimals ?? null,
    totalSupply: d.totalSupply ?? existing?.totalSupply ?? null,
    deployer: d.deployer ?? existing?.deployer ?? null,
    deployTxHash: d.deployTxHash ?? existing?.deployTxHash ?? null,
    owner: d.owner ?? existing?.owner ?? null,
    standard:
      d.standard && d.standard !== "unknown"
        ? d.standard
        : existing?.standard && existing.standard !== "unknown"
          ? existing.standard
          : d.standard ?? "ERC-20",
    templateHint: d.templateHint ?? existing?.templateHint ?? null,
    bytecodeHash: d.bytecodeHash ?? existing?.bytecodeHash ?? null,
    liquidityUsd: d.liquidityUsd ?? existing?.liquidityUsd ?? undefined,
    holderCount: d.holderCount ?? existing?.holderCount ?? undefined,
  };

  const common = {
    ...carried,
    isProxy: d.isProxy,
    isVerified: d.isVerified,
    isActive: d.isActive ?? undefined,
    overallRisk: d.overallRisk,
    confidence: d.confidence,
    topSignalsJson: jstr(d.topSignals),
    hasRobinhoodLink: d.hasRobinhoodLink,
    analysisUpdatedAt: new Date(),
    lastAnalyzedBlock: result.report.lastBlock != null ? BigInt(result.report.lastBlock) : null,
  };

  const token = await prisma.token.upsert({
    where: { chain_address: { chain: d.chain, address: d.address } },
    create: { chain: d.chain, address: d.address, ...common },
    update: common,
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

  // Contract findings plus report findings, deduped. Storing only topFindings
  // would silently drop everything past the eighth signal.
  const merged = new Map<string, Finding>();
  for (const f of [...d.contractFindings, ...result.report.topFindings]) {
    if (!merged.has(f.id)) merged.set(f.id, f);
  }

  // Delete and insert must land together, otherwise a failed insert leaves the
  // token with no findings at all.
  await prisma.$transaction(async (tx) => {
    await tx.finding.deleteMany({ where: { tokenId: token.id, source: "automatic" } });
    if (merged.size) {
      await tx.finding.createMany({
        data: [...merged.values()].map((f) => ({
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

  await prisma.$transaction(async (tx) => {
    await tx.tokenHolder.deleteMany({ where: { tokenId: token.id } });
    if (d.holders.length) {
      await tx.tokenHolder.createMany({
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
  });

  await prisma.$transaction(async (tx) => {
    await tx.liquidityPoolRow.deleteMany({ where: { tokenId: token.id } });
    if (d.pools.length) {
      await tx.liquidityPoolRow.createMany({
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
  });

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
      const evidenceJson = jstr([{ type: "bytecode", chain: d.chain, value: d.bytecodeHash }]);
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
          evidenceJson,
          label: "identical deployed bytecode",
        },
        update: { evidenceJson },
      });
    }
  }

  // Re-analysing a token used to append a duplicate row per link every run.
  // The snapshot is replaced instead.
  await prisma.$transaction(async (tx) => {
    await tx.crossChainLinkRow.deleteMany({
      where: { fromAddress: { in: [d.address, ...(d.deployer ? [d.deployer] : [])] } },
    });
    if (d.crossChainLinks.length) {
      await tx.crossChainLinkRow.createMany({
        data: d.crossChainLinks.map((l) => ({
          strength: l.strength,
          fromChain: l.fromChain,
          toChain: l.toChain,
          fromAddress: l.fromAddress,
          toAddress: l.toAddress,
          reason: l.reason,
          evidenceJson: jstr(l.evidence),
          relatedEventIdsJson: jstr(l.relatedEventIds),
        })),
      });
    }
  });

  if (d.deployer) {
    await prisma.wallet.upsert({
      where: { chain_address: { chain: d.chain, address: d.deployer } },
      create: {
        chain: d.chain,
        address: d.deployer,
        firstSeenAt: d.deployerProfile?.firstSeenAt ? new Date(d.deployerProfile.firstSeenAt) : null,
        lastSeenAt: d.deployerProfile?.lastSeenAt ? new Date(d.deployerProfile.lastSeenAt) : null,
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
