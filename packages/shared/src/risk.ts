/**
 * Risk model types and scoring rules.
 * Evidence-based only. No invented scammer labels.
 */

export type OverallRiskLevel =
  | "low_detected_risk"
  | "caution"
  | "high_risk"
  | "critical_risk"
  | "insufficient_data";

export type ConfidenceLevel = "high" | "medium" | "low";

export type RiskCategoryKey =
  | "contract"
  | "owner_admin"
  | "buy_sell"
  | "liquidity"
  | "holder_concentration"
  | "insider_links"
  | "deployer_history"
  | "cross_chain"
  | "market_behavior"
  | "data_gaps";

export type RiskSeverity = "info" | "low" | "medium" | "high" | "critical";

export type EventClass =
  | "confirmed_malicious"
  | "high_risk_exit"
  | "suspicious_rug_behavior"
  | "honeypot_behavior"
  | "abandoned_token"
  | "heavy_insider_control"
  | "insufficient_evidence";

export type LinkStrength = "definitive" | "strong" | "medium" | "weak_behavioral";

export type FindingStatus = "theoretical" | "active" | "observed";

export interface EvidenceRef {
  type: "tx" | "address" | "contract" | "bytecode" | "log" | "simulation" | "block" | "external";
  chain: string;
  value: string;
  label?: string;
  url?: string;
}

export interface RiskFinding {
  id: string;
  category: RiskCategoryKey;
  name: string;
  severity: RiskSeverity;
  status: FindingStatus;
  summary: string;
  whyItMatters: string;
  controllerAddress?: string;
  relatedFunction?: string;
  evidence: EvidenceRef[];
  /** Automatic vs manual review */
  source: "automatic" | "manual";
  manualOverride?: {
    decision: string;
    reason: string;
    reviewer?: string;
    at: string;
  };
}

export interface CategoryScore {
  category: RiskCategoryKey;
  score: number; // 0-100, higher = more risk
  label: string;
  findings: RiskFinding[];
  dataComplete: boolean;
  explanation: string;
}

export interface RiskReport {
  overall: OverallRiskLevel;
  confidence: ConfidenceLevel;
  categories: CategoryScore[];
  topFindings: RiskFinding[];
  modelVersion: string;
  analyzedAt: string;
  lastBlock: number | null;
  dataSources: DataSourceStatus[];
  disclaimer: string;
}

export interface DataSourceStatus {
  key: string;
  name: string;
  healthy: boolean;
  lastSuccessAt?: string;
  lastError?: string;
  lagBlocks?: number;
  usedInThisAnalysis: boolean;
}

export const CATEGORY_LABELS: Record<RiskCategoryKey, string> = {
  contract: "Contract risk",
  owner_admin: "Owner & admin risk",
  buy_sell: "Buy / sell risk",
  liquidity: "Liquidity risk",
  holder_concentration: "Holder concentration",
  insider_links: "Insider links",
  deployer_history: "Deployer history",
  cross_chain: "Cross-chain history",
  market_behavior: "Market behavior",
  data_gaps: "Data gaps",
};

export const OVERALL_LABELS: Record<OverallRiskLevel, string> = {
  low_detected_risk: "Low detected risk",
  caution: "Caution advised",
  high_risk: "High risk",
  critical_risk: "Critical risk",
  insufficient_data: "Insufficient data",
};

export const EVENT_CLASS_LABELS: Record<EventClass, string> = {
  confirmed_malicious: "Confirmed malicious behavior",
  high_risk_exit: "High-risk exit",
  suspicious_rug_behavior: "Suspicious rug-like behavior",
  honeypot_behavior: "Honeypot behavior",
  abandoned_token: "Abandoned token",
  heavy_insider_control: "Heavy insider control",
  insufficient_evidence: "Insufficient evidence",
};

export const LINK_STRENGTH_LABELS: Record<LinkStrength, string> = {
  definitive: "Definitive link",
  strong: "Strong link",
  medium: "Medium link",
  weak_behavioral: "Weak / behavioral similarity",
};

export const SEVERITY_WEIGHT: Record<RiskSeverity, number> = {
  info: 5,
  low: 20,
  medium: 45,
  high: 70,
  critical: 95,
};

export const DISCLAIMER =
  "RiskHound does not guarantee token safety. Absence of detected risk is not safety. " +
  "This is not investment advice. RiskHound never executes trades or holds user funds.";

/**
 * Aggregate category scores into overall level.
 * Critical findings always elevate overall result (not hidden by averages).
 */
export function aggregateOverall(
  categories: CategoryScore[],
  hasCriticalFinding: boolean,
  dataGapScore: number
): OverallRiskLevel {
  if (dataGapScore >= 80 && categories.every((c) => !c.dataComplete || c.findings.length === 0)) {
    return "insufficient_data";
  }

  if (hasCriticalFinding) return "critical_risk";

  const scored = categories.filter((c) => c.category !== "data_gaps");
  if (scored.length === 0) return "insufficient_data";

  const max = Math.max(...scored.map((c) => c.score));
  const avg = scored.reduce((a, c) => a + c.score, 0) / scored.length;

  if (max >= 90 || avg >= 75) return "critical_risk";
  if (max >= 70 || avg >= 55) return "high_risk";
  if (max >= 40 || avg >= 30) return "caution";
  if (dataGapScore >= 60) return "insufficient_data";
  return "low_detected_risk";
}

export function confidenceFromSources(sources: DataSourceStatus[], findingsCount: number): ConfidenceLevel {
  const used = sources.filter((s) => s.usedInThisAnalysis);
  const healthy = used.filter((s) => s.healthy);
  if (used.length === 0) return "low";
  const ratio = healthy.length / used.length;
  if (ratio >= 0.9 && findingsCount >= 0) return "high";
  if (ratio >= 0.6) return "medium";
  return "low";
}

export function scoreFromFindings(findings: RiskFinding[]): number {
  if (findings.length === 0) return 0;
  const weights = findings.map((f) => SEVERITY_WEIGHT[f.severity]);
  const max = Math.max(...weights);
  const avg = weights.reduce((a, b) => a + b, 0) / weights.length;
  // Emphasize worst finding so averages cannot bury criticals
  return Math.min(100, Math.round(max * 0.7 + avg * 0.3));
}
