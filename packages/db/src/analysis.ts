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
    /**
     * Every finding the run scored, grouped by category. topFindings is capped
     * at eight by the scorer, so this is the only complete list, and a finding
     * that is absent from it really was not produced this run. dataComplete
     * says whether the category could be read at all this run, which is what
     * separates a signal that lapsed from one that could not be measured.
     */
    categories?: { category?: string; dataComplete?: boolean; findings: Finding[] }[];
    lastBlock: number | null;
    dataSources: unknown[];
  };
  graph: Parameters<typeof persistEvidenceGraph>[0];
};

// Two runs for the same token interleaving their delete-then-insert steps can
// leave duplicated or missing child rows, so writes are queued per token. This
// covers one process only, and only the async API path goes through the queue:
// POST /tokens/:address/analyze without `async` persists inside the API
// process, so an API run and a worker run for the same token are not serialised
// against each other at all. Closing that needs a database-level lock.
const tokenWrites = new Map<string, Promise<unknown>>();

/**
 * Single writer for an analysis result. The worker and the paid API both call
 * this, so a token's stored record does not depend on which path analysed it.
 */
export function persistAnalysisResult(result: AnalysisResultLike) {
  const key = `${result.detail.chain}:${result.detail.address}`.toLowerCase();
  const previous = tokenWrites.get(key) ?? Promise.resolve();
  const run = previous.then(() => writeAnalysisResult(result));
  // The queued tail swallows rejection so one failed run does not fail the next.
  const settled = run.then(
    () => undefined,
    () => undefined
  );
  tokenWrites.set(key, settled);
  void settled.then(() => {
    if (tokenWrites.get(key) === settled) tokenWrites.delete(key);
  });
  return run;
}

async function writeAnalysisResult(result: AnalysisResultLike) {
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

  const metadata = {
    ...carried,
    isProxy: d.isProxy,
    isVerified: d.isVerified,
    isActive: d.isActive ?? undefined,
    hasRobinhoodLink: d.hasRobinhoodLink,
  };

  // The verdict and the freshness stamp are written after every child write has
  // landed. Stamping them here let a failure in the holders or graph steps
  // leave a current timestamp and a fresh risk grade standing over the previous
  // run's holders, pools and edges, which /tokens/:address then reported as
  // current.
  const verdict = {
    overallRisk: d.overallRisk,
    confidence: d.confidence,
    topSignalsJson: jstr(d.topSignals),
    analysisUpdatedAt: new Date(),
    lastAnalyzedBlock: result.report.lastBlock != null ? BigInt(result.report.lastBlock) : null,
  };

  const token = await prisma.token.upsert({
    where: { chain_address: { chain: d.chain, address: d.address } },
    create: { chain: d.chain, address: d.address, ...metadata },
    update: metadata,
  });

  // report.categories holds every finding the run scored; topFindings is capped
  // at eight, so storing that alone left the ninth signal with no row, and a
  // finding with no row can never be reviewed or overridden. contractFindings
  // is the fallback for a caller that passes no categories, and comes last so
  // the scored copy of a finding wins: the scorer reclassifies a finding with
  // no evidence to data_gaps, and that judgement is the one worth storing.
  const scored = result.report.categories?.flatMap((c) => c.findings);
  // A category the run could not read produces no findings either, so absence
  // alone cannot tell a lapsed signal from an unread one. Only a category that
  // was readable end to end may retire anything, otherwise an explorer outage
  // marks a reviewed finding as no longer firing, which reads as the risk
  // having gone away rather than as the gap it is.
  const completeCategories = new Set(
    (result.report.categories ?? [])
      .filter((c) => c.dataComplete !== false)
      .map((c) => c.category)
      .filter((c): c is string => Boolean(c))
  );
  const merged = new Map<string, Finding>();
  for (const f of [...(scored ?? []), ...result.report.topFindings, ...d.contractFindings]) {
    if (!merged.has(f.id)) merged.set(f.id, f);
  }

  // Delete and insert must land together, otherwise a failed insert leaves the
  // token with no findings at all.
  await prisma.$transaction(async (tx) => {
    // An admin override keeps source "automatic" and only sets the manual*
    // columns, so deleting by source alone threw away every reviewed decision
    // on each re-analysis. Reviewed rows survive and are refreshed in place so
    // the reviewer's row stays the only one for that finding.
    const reviewed = await tx.finding.findMany({
      where: { tokenId: token.id, source: "automatic", manualAt: { not: null } },
      select: { id: true, category: true, name: true },
    });
    // controllerAddress used to be part of this key. It comes from owner(),
    // whose read is allowed to fail, so a run where the node did not answer
    // missed the reviewed row and inserted a second copy of the same finding
    // beside it. The current reading is written into the row instead.
    const key = (f: { category: string; name: string }) => `${f.category}::${f.name}`;
    // Duplicates created before that fix can still exist, and keeping only one
    // id per key would leave the others frozen at their review-time severity.
    const reviewedIds = new Map<string, string[]>();
    for (const f of reviewed) {
      const group = reviewedIds.get(key(f));
      if (group) group.push(f.id);
      else reviewedIds.set(key(f), [f.id]);
    }
    await tx.finding.deleteMany({
      where: { tokenId: token.id, source: "automatic", manualAt: null },
    });
    const fresh: Finding[] = [];
    const reproduced = new Set<string>();
    for (const f of merged.values()) {
      const ids = reviewedIds.get(key(f));
      if (!ids) {
        fresh.push(f);
        continue;
      }
      reproduced.add(key(f));
      // Severity and summary for several findings scale with the measured
      // value, so discarding the fresh detection would pin a reviewed row to
      // the numbers it carried at review time and hide any later escalation.
      // The manual* columns are untouched, so the decision itself survives.
      for (const id of ids) {
        await tx.finding.update({
          where: { id },
          data: {
            severity: f.severity,
            status: f.status,
            summary: f.summary,
            whyItMatters: f.whyItMatters,
            controllerAddress: f.controllerAddress,
            relatedFunction: f.relatedFunction,
            evidenceJson: jstr(f.evidence),
            // The signal is firing again, so it is not retired.
            retiredAt: null,
          },
        });
      }
    }
    // deleteMany excludes reviewed rows, so a reviewed finding the detector
    // stopped producing used to be served as a current signal forever. It is
    // marked instead of deleted so the reviewer's decision survives next to the
    // fact that the signal lapsed. Only a complete finding set may retire a
    // row: with topFindings alone a ninth-ranked signal is missing, not gone,
    // and within that set only a category that was actually readable.
    if (scored) {
      const lapsed = reviewed.filter(
        (f) => !reproduced.has(key(f)) && completeCategories.has(f.category)
      );
      if (lapsed.length) {
        await tx.finding.updateMany({
          where: { id: { in: lapsed.map((f) => f.id) } },
          data: { retiredAt: new Date() },
        });
      }
    }
    if (fresh.length) {
      await tx.finding.createMany({
        data: fresh.map((f) => ({
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

  // An explorer that repeats a holder across pages would break the insert on
  // @@unique([tokenId, address]) and roll the whole snapshot back, leaving the
  // previous run's holders in place.
  const holders = [...new Map(d.holders.map((h) => [h.address.toLowerCase(), h])).values()];

  await prisma.$transaction(async (tx) => {
    await tx.tokenHolder.deleteMany({ where: { tokenId: token.id } });
    if (holders.length) {
      await tx.tokenHolder.createMany({
        data: holders.map((h) => ({
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
    findings: [...merged.values()],
    completeCategories: scored ? [...completeCategories] : null,
  });

  if (d.bytecodeHash) {
    const reused = await prisma.token.findMany({
      where: { bytecodeHash: d.bytecodeHash, id: { not: token.id } },
      take: 20,
    });
    if (reused.length) {
      const evidenceJson = jstr([{ type: "bytecode", chain: d.chain, value: d.bytecodeHash }]);
      // A token from a common template fills all twenty of these, and they
      // differ only by fingerprint, so they go as one round trip rather than
      // twenty while the request waits.
      await prisma.$transaction(
        reused.map((other) => {
          const fingerprint = `${d.chain}:${d.address}:${other.address}:copied_contract`.toLowerCase();
          return prisma.graphEdgeRow.upsert({
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
        })
      );
    }
  }

  // Re-analysing a token used to append a duplicate row per link every run, so
  // the snapshot is replaced. It is scoped by token id: the links point at the
  // deployer and the top holders as often as at the token, so deleting by
  // address also threw away the snapshot of every sibling token from the same
  // deployer. Rows written before tokenId existed carry null and are matched by
  // this token's own address.
  await prisma.$transaction(async (tx) => {
    await tx.crossChainLinkRow.deleteMany({
      where: { OR: [{ tokenId: token.id }, { tokenId: null, fromAddress: d.address }] },
    });
    if (d.crossChainLinks.length) {
      await tx.crossChainLinkRow.createMany({
        data: d.crossChainLinks.map((l) => ({
          tokenId: token.id,
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
        // firstSeenAt is deliberately left alone: it records the earliest
        // observation and a later run cannot improve on it. lastSeenAt froze at
        // creation, which described every known deployer as dormant.
        lastSeenAt: d.deployerProfile?.lastSeenAt ? new Date(d.deployerProfile.lastSeenAt) : undefined,
      },
    });
  }

  // Last, so that the freshness stamp and the risk grade only ever describe a
  // run whose children all landed. A failure above leaves the previous verdict
  // and timestamp in place, which reads as stale rather than as current.
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

  return prisma.token.update({ where: { id: token.id }, data: verdict });
}
