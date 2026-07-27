import {
  explorerAddressUrl,
  explorerTxUrl,
  type RiskFinding,
  type RiskReport,
  type TokenDetail,
  type DataSourceStatus,
  type TimelineEvent,
} from "@rugkiller/shared";
import { getArcClients, getRobinhoodClients, normalizeAddress } from "@rugkiller/chain";
import { analyzeContract } from "./contract.js";
import { analyzeApexiSwap, APEXISWAP } from "./dex.js";
import { analyzeHolders } from "./holders.js";
import { analyzeLiquidity } from "./liquidity.js";
import { buildDeployerProfile } from "./deployer.js";
import { compareCrossChain } from "./crosschain.js";
import { buildFundingGraph } from "./graph.js";
import { buildRiskReport } from "./scoring.js";
import type { RiskEventSummary } from "@rugkiller/shared";

export interface AnalyzeTokenOptions {
  address: string;
  /** Preloaded RH risk events from DB */
  rhRiskEvents?: RiskEventSummary[];
  skipCrossChain?: boolean;
  skipSimulation?: boolean;
}

export interface AnalyzeTokenResult {
  detail: TokenDetail;
  report: RiskReport;
  graph: ReturnType<typeof buildFundingGraph>;
  errors: string[];
}

export async function analyzeToken(opts: AnalyzeTokenOptions): Promise<AnalyzeTokenResult> {
  const addr = normalizeAddress(opts.address);
  if (!addr) {
    throw new Error(`Invalid address: ${opts.address}`);
  }

  const arc = getArcClients();
  const errors: string[] = [];
  const allFindings: RiskFinding[] = [];
  const dataSources: DataSourceStatus[] = [];
  const timeline: TimelineEvent[] = [];

  // Nothing in this group consumes anything else in it: the two health probes
  // read no token data, analyzeContract and analyzeApexiSwap read different
  // sources, and the token transfer page is shared by the holder and liquidity
  // analyzers below. Awaited one at a time these were the whole prologue of
  // every analysis, ahead of any other analyzer.
  const [blockProbe, rpcProbe, contract, dexRead, transfersRead] = await Promise.all([
    arc.explorer
      .getLatestBlock()
      .then((block) => ({ ok: true as const, block }))
      .catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) })),
    arc.rpc
      ? arc.rpc
          .getBlockNumber()
          .then(() => ({ ok: true as const }))
          .catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }))
      : Promise.resolve(null),
    analyzeContract({
      chain: "arc_testnet",
      address: addr,
      rpc: arc.rpc,
      explorer: arc.explorer,
      explorerUrl: arc.network.explorerUrl,
    }),
    // One failing pair read must not discard a report where every other
    // analyzer answered. The DEX result becomes a recorded gap instead.
    analyzeApexiSwap({
      chain: "arc_testnet",
      token: addr,
      rpc: arc.rpc,
      explorer: arc.explorer,
      // The flag used to be applied after the round trip had already run, so
      // the callers that ask for a cheap graph paid for it in full.
      skipSimulation: opts.skipSimulation,
    })
      .then((value) => ({ ok: true as const, value }))
      .catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) })),
    arc.explorer
      .getTokenTransfers(addr)
      .then((page) => ({ ok: true as const, page }))
      .catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) })),
  ]);

  // Health probes
  const lastBlock = blockProbe.ok ? blockProbe.block?.number ?? null : null;
  dataSources.push({
    key: "arc_explorer",
    name: "Arc Blockscout",
    healthy: lastBlock != null,
    // A read that did not answer must not be stamped with a fresh success
    // time; the agent API publishes this field as data freshness.
    ...(lastBlock != null ? { lastSuccessAt: new Date().toISOString() } : {}),
    ...(blockProbe.ok ? {} : { lastError: blockProbe.error }),
    usedInThisAnalysis: true,
    lagBlocks: 0,
  });
  if (lastBlock == null) {
    // getLatestBlock reports an outage by returning null rather than throwing,
    // so the old catch never ran and no explorer problem reached `errors`.
    errors.push("Arc explorer unhealthy");
  }

  // A constructed client object is not a working node. Health has to come from
  // an answer, otherwise a dead RPC is reported as a healthy source and lifts
  // the confidence of an analysis that read nothing.
  if (!arc.rpc) {
    dataSources.push({
      key: "arc_rpc",
      name: "Arc RPC",
      healthy: false,
      usedInThisAnalysis: false,
      lastError: "RPC not configured",
    });
  } else if (rpcProbe?.ok) {
    dataSources.push({
      key: "arc_rpc",
      name: "Arc RPC",
      healthy: true,
      lastSuccessAt: new Date().toISOString(),
      usedInThisAnalysis: true,
    });
  } else {
    dataSources.push({
      key: "arc_rpc",
      name: "Arc RPC",
      healthy: false,
      lastError: rpcProbe && !rpcProbe.ok ? rpcProbe.error : "RPC probe did not complete",
      usedInThisAnalysis: true,
    });
    errors.push("Arc RPC unhealthy");
  }

  errors.push(...contract.errors);
  allFindings.push(...contract.findings);

  if (contract.deployTxHash) {
    timeline.push({
      id: `deploy-${contract.deployTxHash}`,
      type: "deploy",
      // Nothing here reads the deploy block time, and the analysis time would
      // date the deployment to the moment it was looked at.
      timestamp: null,
      chain: "arc_testnet",
      title: "Token contract deployment",
      txHash: contract.deployTxHash,
      addresses: [contract.deployer ?? "", addr].filter(Boolean),
    });
  }

  let dex: Awaited<ReturnType<typeof analyzeApexiSwap>> | null = null;
  if (dexRead.ok) {
    dex = dexRead.value;
  } else {
    errors.push(`dex: ${dexRead.error}`);
    allFindings.push({
      id: `dex-unavailable-${addr}`,
      category: "data_gaps",
      name: "DEX pair analysis unavailable",
      severity: "medium",
      status: "observed",
      summary: "The verified DEX lookup did not complete, so pool state and tradability were not read.",
      whyItMatters: "Untested tradability and unknown LP ownership are gaps, not evidence that the token is tradable.",
      evidence: [
        { type: "contract", chain: "arc_testnet", value: addr, label: "Token whose DEX lookup failed" },
      ],
      source: "automatic",
    });
  }
  const simulation = opts.skipSimulation ? null : dex?.simulation ?? null;

  // These three read only fields analyzeContract already produced, and nothing
  // any of them produces. allSettled rather than all so a rejection in one
  // cannot leave a sibling's rejection unhandled; a throwing analyzer still
  // ends the analysis exactly as it did when they ran one after another.
  const [holdersRead, liquidityRead, deployerRead] = await Promise.allSettled([
    analyzeHolders({
      chain: "arc_testnet",
      token: addr,
      explorer: arc.explorer,
      deployer: contract.deployer,
      totalSupply: contract.totalSupply,
      // The pair holds the float by construction. Counting it made a token with
      // healthy exit liquidity read as highly concentrated, and named the pool
      // itself as the suspicious holder.
      poolAddresses: [dex?.pair?.address, APEXISWAP.router, APEXISWAP.factory],
      transfers: transfersRead,
    }),
    analyzeLiquidity({
      chain: "arc_testnet",
      token: addr,
      explorer: arc.explorer,
      deployer: contract.deployer,
      // Both of these were fetched again here for data this analysis already
      // had in memory.
      exchangeRate: contract.exchangeRate,
      transfers: transfersRead,
    }),
    contract.deployer
      ? buildDeployerProfile({
          chain: "arc_testnet",
          address: contract.deployer,
          explorer: arc.explorer,
          currentToken: addr,
        })
      : Promise.resolve(null),
  ]);

  const holders = unwrapSettled(holdersRead);
  const liquidity = unwrapSettled(liquidityRead);
  let deployerProfile = unwrapSettled(deployerRead);

  allFindings.push(...holders.findings);
  errors.push(...holders.errors);

  if (dex?.pair) {
    liquidity.snapshot.pools = [dex.pair];
    liquidity.snapshot.dominantController = dex.lpController;
    liquidity.snapshot.dominantPct = dex.lpControllerPct;
    liquidity.snapshot.fakeOrMeaningless = dex.pair.reserve0 === "0" || dex.pair.reserve1 === "0";
    liquidity.snapshot.notes = dex.notes;
    // A pair address alone does not close the gap. Only LP supply and holder
    // rows that were actually read turn "unknown" into an observation, so a
    // pair whose LP reads all failed keeps reporting the gap.
    if (dex.lpDataComplete) {
      liquidity.findings = liquidity.findings.filter((f) => f.name !== "Liquidity pool data incomplete");
    }
    if ((dex.lpControllerPct ?? 0) >= 50) {
      liquidity.findings.push({
        id: `lp-control-${dex.pair.address}`,
        category: "liquidity",
        name: "LP ownership is concentrated",
        severity: (dex.lpControllerPct ?? 0) >= 90 ? "critical" : "high",
        status: "observed",
        summary: `The largest non-burn LP holder controls approximately ${dex.lpControllerPct?.toFixed(2)}% of tracked LP supply.`,
        whyItMatters: "A concentrated LP position may be able to remove most exit liquidity.",
        controllerAddress: dex.lpController ?? undefined,
        evidence: [{ type: "contract", chain: "arc_testnet", value: dex.pair.address, label: "APEXISWAP pair" }],
        source: "automatic",
      });
    }
  }
  allFindings.push(...liquidity.findings);
  errors.push(...liquidity.errors);
  timeline.push(...liquidity.snapshot.recentAdds, ...liquidity.snapshot.recentRemoves);

  // An explorer that answers for the token but holds no creator record leaves
  // both the deployer and the cross-chain analyzer unrun. Neither pushes an
  // error, so without this the two categories are silently empty, and an empty
  // category reads as examined and clean.
  if (!contract.deployer) {
    allFindings.push({
      id: `deployer-unknown-${addr}`,
      category: "data_gaps",
      name: "Contract creator could not be identified",
      severity: "medium",
      status: "observed",
      summary:
        "No creator address was returned for this contract, so deployer history and cross-chain history were not examined.",
      whyItMatters:
        "An unidentified deployer is unknown, not clean. Neither the wallet's history nor its activity on other networks could be checked.",
      evidence: [
        { type: "contract", chain: "arc_testnet", value: addr, label: "Contract with no known creator" },
      ],
      source: "automatic",
    });
  }

  let crossLinks = [] as Awaited<ReturnType<typeof compareCrossChain>>["links"];
  let crossChainComplete = false;
  if (!opts.skipCrossChain && contract.deployer) {
    try {
      const rh = getRobinhoodClients();
      let rhHealthy = false;
      try {
        const rb = await rh.explorer.getLatestBlock();
        rhHealthy = rb != null;
        dataSources.push({
          key: "rh_explorer",
          name: "Robinhood Blockscout",
          healthy: rhHealthy,
          lastSuccessAt: new Date().toISOString(),
          usedInThisAnalysis: true,
        });
      } catch (e) {
        dataSources.push({
          key: "rh_explorer",
          name: "Robinhood Blockscout",
          healthy: false,
          lastError: e instanceof Error ? e.message : String(e),
          usedInThisAnalysis: true,
        });
      }

      const xc = await compareCrossChain({
        arcAddress: contract.deployer,
        relatedAddresses: [
          contract.deployer,
          deployerProfile?.firstFunder,
          ...holders.holders.slice(0, 5).map((h) => h.address),
        ].filter(Boolean) as string[],
        arcExplorer: arc.explorer,
        rhExplorer: rh.explorer,
        rhRiskEvents: opts.rhRiskEvents,
      });
      crossLinks = xc.links;
      allFindings.push(...xc.findings);
      errors.push(...xc.errors);
      // An address whose outside-chain lookup failed was not examined, so the
      // category only counts as complete when every lookup answered.
      crossChainComplete = xc.errors.length === 0;
      if (deployerProfile) {
        deployerProfile = { ...deployerProfile, crossChain: xc.links };
      }
    } catch (e) {
      errors.push(`cross-chain: ${e instanceof Error ? e.message : String(e)}`);
      dataSources.push({
        key: "rh_explorer",
        name: "Robinhood Blockscout",
        healthy: false,
        lastError: e instanceof Error ? e.message : String(e),
        usedInThisAnalysis: true,
      });
    }
  }

  const report = buildRiskReport({
    findings: allFindings,
    dataSources,
    lastBlock,
    chain: "arc_testnet",
    tokenAddress: addr,
    buySellFindingHints: simulation
      ? {
          canBuy: simulation.canBuy,
          canSell: simulation.canSell,
          dataComplete: simulation.dataComplete,
          evidence: simulation.steps.flatMap((s) => s.evidence ?? []),
        }
      : undefined,
    deployerHistoryLabel: deployerProfile?.historyLabel,
    deployerAddress: contract.deployer,
    // Completeness reported by the analyzers themselves, so a category is only
    // called complete when the reads behind it actually answered. A category
    // left out here defaults to complete, which publishes a dimension that was
    // never examined as examined and clean.
    analyzerCompleteness: {
      // "Not verified" is something the explorer told us, and it is already
      // carried as a contract finding. Reading it as a gap pinned every
      // unverified token below high confidence for a read that never failed.
      contract: contract.errors.length === 0 && contract.codeRead,
      // Both producers of this category need the bytecode: the selector scan
      // reads it directly, and a node that refuses eth_getCode refuses the
      // owner() read too.
      owner_admin: contract.codeRead,
      buy_sell: simulation?.dataComplete ?? false,
      liquidity: dex?.lpDataComplete ?? false,
      holder_concentration: holders.dataComplete,
      insider_links:
        holders.holderListComplete &&
        holders.transferHistoryComplete &&
        holders.funderScanComplete,
      // A wallet history that was truncated or never read establishes nothing
      // about the deployer in either direction.
      deployer_history: deployerProfile != null && deployerProfile.historyLabel !== "unknown",
      cross_chain: crossChainComplete,
    },
  });

  const graph = buildFundingGraph({
    tokenAddress: addr,
    tokenSymbol: contract.symbol,
    deployer: contract.deployer,
    holders: holders.holders,
    links: crossLinks,
    firstFunder: deployerProfile?.firstFunder,
  });

  const topSignals = report.topFindings.slice(0, 3).map((f) => f.name);

  const detail: TokenDetail = {
    id: `arc_testnet:${addr.toLowerCase()}`,
    chain: "arc_testnet",
    address: addr.toLowerCase(),
    name: contract.name,
    symbol: contract.symbol,
    decimals: contract.decimals,
    totalSupply: contract.totalSupply,
    standard: "ERC-20",
    deployer: contract.deployer,
    deployTxHash: contract.deployTxHash,
    deployBlock: null,
    deployTimestamp: null,
    owner: contract.owner,
    isProxy: contract.isProxy,
    isVerified: contract.isVerified,
    templateHint: contract.templateHint,
    bytecodeHash: contract.bytecodeHash,
    firstLiquidityUsd: null,
    liquidityUsd: liquidity.snapshot.totalUsd,
    // A capped page walk is a floor, not the holder count. Stored, it
    // overwrote the explorer's true count from discovery and ranked a large
    // token below a small one on the holders leaderboard.
    holderCount: holders.holderListComplete ? holders.holderCount : null,
    isActive: holders.holders.length > 0 || (simulation?.canBuy ?? null),
    overallRisk: report.overall,
    confidence: report.confidence,
    topSignals,
    // Legacy storage field: true only when an outside-chain risk event is
    // linked to this Arc creator, never for ordinary outside-chain activity.
    hasRobinhoodLink: crossLinks.some((l) => l.relatedEventIds.length > 0),
    analysisUpdatedAt: report.analyzedAt,
    createdAt: new Date().toISOString(),
    report,
    contractFindings: contract.findings,
    simulation,
    liquidity: liquidity.snapshot,
    holders: holders.holders,
    insiderClusters: holders.clusters,
    deployerProfile,
    crossChainLinks: crossLinks,
    timeline: timeline.sort(byNewestFirst),
    pools: liquidity.snapshot.pools,
    dataSources,
    explorerUrls: {
      address: explorerAddressUrl(arc.network, addr),
      tx: contract.deployTxHash
        ? explorerTxUrl(arc.network, contract.deployTxHash)
        : undefined,
    },
  };

  return { detail, report, graph, errors };
}

/**
 * Analyzers that used to be awaited in sequence now run together, so their
 * rejections have to be collected rather than raced. Rethrowing here keeps the
 * old behaviour: the first failing analyzer still ends the analysis.
 */
function unwrapSettled<T>(result: PromiseSettledResult<T>): T {
  if (result.status === "rejected") throw result.reason;
  return result.value;
}

/**
 * Newest first. Equal timestamps must compare equal, otherwise the relative
 * order of equal events is left to the sort implementation. Events with no
 * known chain time sort last rather than being placed as if they were oldest.
 */
function byNewestFirst(a: TimelineEvent, b: TimelineEvent): number {
  const at: string | null = a.timestamp ?? null;
  const bt: string | null = b.timestamp ?? null;
  if (at === bt) return 0;
  if (at == null) return 1;
  if (bt == null) return -1;
  return at < bt ? 1 : at > bt ? -1 : 0;
}
