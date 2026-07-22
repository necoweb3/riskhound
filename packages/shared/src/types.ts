import type {
  ConfidenceLevel,
  EventClass,
  EvidenceRef,
  LinkStrength,
  OverallRiskLevel,
  RiskFinding,
  RiskReport,
} from "./risk.js";

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

export interface TokenSummary {
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
  deployBlock: number | null;
  deployTimestamp: string | null;
  owner: string | null;
  isProxy: boolean;
  isVerified: boolean;
  templateHint: string | null;
  bytecodeHash: string | null;
  firstLiquidityUsd: number | null;
  liquidityUsd: number | null;
  holderCount: number | null;
  isActive: boolean | null;
  overallRisk: OverallRiskLevel | null;
  confidence: ConfidenceLevel | null;
  topSignals: string[];
  hasRobinhoodLink: boolean;
  analysisUpdatedAt: string | null;
  createdAt: string;
}

export interface TokenDetail extends TokenSummary {
  report: RiskReport | null;
  contractFindings: RiskFinding[];
  simulation: SimulationResult | null;
  liquidity: LiquiditySnapshot | null;
  holders: HolderInfo[];
  insiderClusters: InsiderCluster[];
  deployerProfile: DeployerProfile | null;
  crossChainLinks: CrossChainLink[];
  timeline: TimelineEvent[];
  pools: LiquidityPool[];
  dataSources: RiskReport["dataSources"];
  explorerUrls: { address: string; tx?: string };
}

export interface SimulationStep {
  step: string;
  success: boolean;
  detail: string;
  gasUsed?: string;
  error?: string;
  evidence?: EvidenceRef[];
}

export interface SimulationResult {
  canBuy: boolean | null;
  canSell: boolean | null;
  buyTaxBps: number | null;
  sellTaxBps: number | null;
  steps: SimulationStep[];
  summary: string;
  simulatedAt: string;
  method: "eth_call" | "trace" | "historical_tx" | "hybrid";
  dataComplete: boolean;
}

export interface LiquidityPool {
  address: string;
  dex: string | null;
  token0: string;
  token1: string;
  reserve0: string | null;
  reserve1: string | null;
  liquidityUsd: number | null;
  lpTokenHolders?: { address: string; balance: string; pct?: number }[];
  locked: boolean | null;
  lockUntil: string | null;
  burned: boolean | null;
}

export interface LiquiditySnapshot {
  totalUsd: number | null;
  pools: LiquidityPool[];
  dominantController: string | null;
  dominantPct: number | null;
  recentAdds: TimelineEvent[];
  recentRemoves: TimelineEvent[];
  fakeOrMeaningless: boolean;
  notes: string[];
}

export interface HolderInfo {
  address: string;
  balance: string;
  pct: number | null;
  isContract: boolean | null;
  labels: string[];
  firstSeenAt?: string;
}

export interface InsiderCluster {
  id: string;
  addresses: string[];
  totalPct: number | null;
  reason: string;
  confidence: ConfidenceLevel;
  evidence: EvidenceRef[];
}

export interface DeployerProfile {
  address: string;
  chain: string;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  ageDays: number | null;
  historyLabel: "limited_history" | "established" | "unknown";
  firstFunder: string | null;
  tokensDeployed: number;
  previousTokens: {
    address: string;
    name: string | null;
    symbol: string | null;
    chain: string;
    status: string | null;
    peakLiquidityUsd: number | null;
    liquidityPulled: boolean | null;
    lifetimeHours: number | null;
  }[];
  riskEvents: RiskEventSummary[];
  crossChain: CrossChainLink[];
}

export interface CrossChainLink {
  id: string;
  strength: LinkStrength;
  fromChain: string;
  toChain: string;
  fromAddress: string;
  toAddress: string;
  reason: string;
  evidence: EvidenceRef[];
  relatedEventIds: string[];
}

export interface TimelineEvent {
  id: string;
  type: string;
  timestamp: string;
  chain: string;
  title: string;
  detail?: string;
  txHash?: string;
  addresses?: string[];
  severity?: string;
}

export interface RiskEventSummary {
  id: string;
  chain: string;
  eventClass: EventClass;
  title: string;
  tokenAddress?: string;
  addresses: string[];
  confidence: ConfidenceLevel;
  autoDetected: boolean;
  manualStatus: "pending" | "confirmed" | "rejected" | "none";
  occurredAt: string;
  evidence: EvidenceRef[];
}

export interface WalletProfile {
  address: string;
  chains: {
    chain: string;
    firstSeenAt: string | null;
    lastSeenAt: string | null;
    txCount: number | null;
    tokensDeployed: number;
    labels: string[];
  }[];
  fundingSources: { chain: string; from: string; txHash?: string; at?: string }[];
  deployedTokens: TokenSummary[];
  riskEvents: RiskEventSummary[];
  links: CrossChainLink[];
  signals: RiskFinding[];
  timeline: TimelineEvent[];
  serviceInteractions: { address: string; label: string; chain: string }[];
}

export interface GraphNode {
  id: string;
  type:
    | "wallet"
    | "token"
    | "contract"
    | "deployer"
    | "pool"
    | "dex"
    | "launchpad"
    | "funding_wallet"
    | "bridge"
    | "cex"
    | "risk_event"
    | "tx"
    | "template";
  label: string;
  chain?: string;
  risk?: OverallRiskLevel | null;
  meta?: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type:
    | "deployed"
    | "funded"
    | "bought"
    | "sold"
    | "added_liquidity"
    | "removed_liquidity"
    | "transferred"
    | "same_funder"
    | "bridged"
    | "copied_contract"
    | "received_risk_proceeds"
    | "clustered";
  strength: LinkStrength;
  evidence: EvidenceRef[];
  label?: string;
}

export interface FundingGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  hopsToRisk: { address: string; hops: number | null }[];
  pruned: boolean;
  note: string;
}

export interface WatchItem {
  id: string;
  userId: string;
  entityType: "token" | "wallet";
  chain: string;
  address: string;
  createdAt: string;
}

export interface AlertItem {
  id: string;
  userId?: string;
  entityType: "token" | "wallet";
  chain: string;
  address: string;
  type: string;
  severity: string;
  title: string;
  body: string;
  evidence: EvidenceRef[];
  createdAt: string;
  read: boolean;
  dedupeKey: string;
}

export interface AppealRecord {
  id: string;
  entityType: "token" | "wallet" | "event";
  chain: string;
  address: string;
  findingId?: string;
  explanation: string;
  evidenceUrls: string[];
  status: "open" | "in_review" | "accepted" | "rejected";
  decisionReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApiQuote {
  endpoint: string;
  priceUsdc: string;
  network: string;
  chainId: number;
  recipient: string;
  asset: string;
  maxSpendUsdc: string;
  expiresAt: string;
}

export interface PaidAnalysisResponse<T> {
  paid: boolean;
  quote?: ApiQuote;
  result?: T;
  paymentNetwork?: string;
}
