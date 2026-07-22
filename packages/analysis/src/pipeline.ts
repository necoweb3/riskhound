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
import { analyzeApexiSwap } from "./dex.js";
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

  dataSources.push({
    key: "arc_rpc",
    name: "Arc RPC",
    healthy: Boolean(arc.rpc),
    usedInThisAnalysis: Boolean(arc.rpc),
    lastError: arc.rpc ? undefined : "RPC not configured",
  });

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
      timestamp: new Date().toISOString(),
      chain: "arc_testnet",
      title: "Token contract deployment",
      txHash: contract.deployTxHash,
      addresses: [contract.deployer ?? "", addr].filter(Boolean),
    });
  }

  const dex = await analyzeApexiSwap({
    chain: "arc_testnet",
    token: addr,
    tokenDecimals: contract.decimals,
    rpc: arc.rpc,
    explorer: arc.explorer,
  });
  const simulation = opts.skipSimulation ? null : dex.simulation;

  const holders = await analyzeHolders({
    chain: "arc_testnet",
    token: addr,
    explorer: arc.explorer,
    deployer: contract.deployer,
    totalSupply: contract.totalSupply,
  });
  allFindings.push(...holders.findings);
  errors.push(...holders.errors);

  const liquidity = await analyzeLiquidity({
    chain: "arc_testnet",
    token: addr,
    explorer: arc.explorer,
    deployer: contract.deployer,
  });
  if (dex.pair) {
    liquidity.snapshot.pools = [dex.pair];
    liquidity.snapshot.dominantController = dex.lpController;
    liquidity.snapshot.dominantPct = dex.lpControllerPct;
    liquidity.snapshot.fakeOrMeaningless = dex.pair.reserve0 === "0" || dex.pair.reserve1 === "0";
    liquidity.snapshot.notes = dex.notes;
    liquidity.findings = liquidity.findings.filter((f) => f.name !== "Liquidity pool data incomplete");
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
    buySellFindingHints: simulation
      ? {
          canBuy: simulation.canBuy,
          canSell: simulation.canSell,
          dataComplete: simulation.dataComplete,
        }
      : undefined,
    deployerHistoryLabel: deployerProfile?.historyLabel,
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
    holderCount: holders.holders.length || null,
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
    timeline: timeline.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)),
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
