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

  // Health probes
  let lastBlock: number | null = null;
  try {
    const b = await arc.explorer.getLatestBlock();
    lastBlock = b?.number ?? null;
    dataSources.push({
      key: "arc_explorer",
      name: "Arc Blockscout",
      healthy: lastBlock != null,
      lastSuccessAt: new Date().toISOString(),
      usedInThisAnalysis: true,
      lagBlocks: 0,
    });
  } catch (e) {
    dataSources.push({
      key: "arc_explorer",
      name: "Arc Blockscout",
      healthy: false,
      lastError: e instanceof Error ? e.message : String(e),
      usedInThisAnalysis: true,
    });
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
  } else {
    try {
      await arc.rpc.getBlockNumber();
      dataSources.push({
        key: "arc_rpc",
        name: "Arc RPC",
        healthy: true,
        lastSuccessAt: new Date().toISOString(),
        usedInThisAnalysis: true,
      });
    } catch (e) {
      dataSources.push({
        key: "arc_rpc",
        name: "Arc RPC",
        healthy: false,
        lastError: e instanceof Error ? e.message : String(e),
        usedInThisAnalysis: true,
      });
      errors.push("Arc RPC unhealthy");
    }
  }

  const contract = await analyzeContract({
    chain: "arc_testnet",
    address: addr,
    rpc: arc.rpc,
    explorer: arc.explorer,
    explorerUrl: arc.network.explorerUrl,
  });
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

  // One failing pair read must not discard a report where every other analyzer
  // answered. The DEX result becomes a recorded gap instead.
  let dex: Awaited<ReturnType<typeof analyzeApexiSwap>> | null = null;
  try {
    dex = await analyzeApexiSwap({
      chain: "arc_testnet",
      token: addr,
      tokenDecimals: contract.decimals,
      rpc: arc.rpc,
      explorer: arc.explorer,
    });
  } catch (e) {
    errors.push(`dex: ${e instanceof Error ? e.message : String(e)}`);
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

  const holders = await analyzeHolders({
    chain: "arc_testnet",
    token: addr,
    explorer: arc.explorer,
    deployer: contract.deployer,
    totalSupply: contract.totalSupply,
    // The pair holds the float by construction. Counting it made a token with
    // healthy exit liquidity read as highly concentrated, and named the pool
    // itself as the suspicious holder.
    poolAddresses: [dex?.pair?.address, APEXISWAP.router, APEXISWAP.factory],
  });
  allFindings.push(...holders.findings);
  errors.push(...holders.errors);

  const liquidity = await analyzeLiquidity({
    chain: "arc_testnet",
    token: addr,
    explorer: arc.explorer,
    deployer: contract.deployer,
  });
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

  let deployerProfile = null;
  if (contract.deployer) {
    deployerProfile = await buildDeployerProfile({
      chain: "arc_testnet",
      address: contract.deployer,
      explorer: arc.explorer,
      currentToken: addr,
    });
  }

  let crossLinks = [] as Awaited<ReturnType<typeof compareCrossChain>>["links"];
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
    // called complete when the reads behind it actually answered.
    analyzerCompleteness: {
      contract: contract.errors.length === 0 && !contract.sourceUnavailable,
      buy_sell: simulation?.dataComplete ?? false,
      liquidity: dex?.lpDataComplete ?? false,
      holder_concentration: holders.dataComplete,
      insider_links: holders.holderListComplete,
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
    holderCount: holders.holderCount,
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
