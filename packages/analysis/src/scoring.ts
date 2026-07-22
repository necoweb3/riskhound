import {
  aggregateOverall,
  CATEGORY_LABELS,
  confidenceFromSources,
  DISCLAIMER,
  scoreFromFindings,
  type CategoryScore,
  type DataSourceStatus,
  type RiskCategoryKey,
  type RiskFinding,
  type RiskReport,
} from "@rugkiller/shared";

const ALL_CATEGORIES: RiskCategoryKey[] = [
  "contract",
  "owner_admin",
  "buy_sell",
  "liquidity",
  "holder_concentration",
  "insider_links",
  "deployer_history",
  "cross_chain",
  "market_behavior",
  "data_gaps",
];

export function buildRiskReport(opts: {
  findings: RiskFinding[];
  dataSources: DataSourceStatus[];
  lastBlock: number | null;
  modelVersion?: string;
  buySellFindingHints?: { canBuy: boolean | null; canSell: boolean | null; dataComplete: boolean };
  deployerHistoryLabel?: "limited_history" | "established" | "unknown";
}): RiskReport {
  const findings = [...opts.findings];

  // Derive buy/sell category findings from simulation hints
  if (opts.buySellFindingHints) {
    const { canBuy, canSell, dataComplete } = opts.buySellFindingHints;
    if (canBuy === true && canSell === false) {
      findings.push({
        id: "sim-honeypot",
        category: "buy_sell",
        name: "Sell path failed while buy evidence exists",
        severity: "critical",
        status: "observed",
        summary: "Simulation/history suggests acquisition possible but sell transfer failed.",
      whyItMatters: "Classic honeypot pattern. Users may be unable to exit.",
        evidence: [],
        source: "automatic",
      });
    } else if (!dataComplete) {
      findings.push({
        id: "sim-incomplete",
        category: "buy_sell",
        name: "Buy/sell simulation incomplete",
        severity: "medium",
        status: "observed",
        summary: "Could not fully verify sellability.",
        whyItMatters: "Unknown sell risk must not be treated as safe.",
        evidence: [],
        source: "automatic",
      });
    }
  }

  if (opts.deployerHistoryLabel === "limited_history") {
    findings.push({
      id: "deployer-limited",
      category: "deployer_history",
      name: "Limited deployer history",
      severity: "low",
      status: "observed",
      summary: "Deployer wallet has little onchain history.",
      whyItMatters:
        "Not automatically malicious. This is shown as limited history, not low risk.",
      evidence: [],
      source: "automatic",
    });
  }

  const categories: CategoryScore[] = ALL_CATEGORIES.map((category) => {
    const cf = findings.filter((f) => f.category === category);
    const score = scoreFromFindings(cf);
    const dataComplete = category === "data_gaps" ? true : !cf.some((f) => f.name.toLowerCase().includes("incomplete"));
    return {
      category,
      score: category === "data_gaps" ? scoreFromFindings(cf) : score,
      label: CATEGORY_LABELS[category],
      findings: cf,
      dataComplete,
      explanation:
        cf.length === 0
          ? "No signals in this category from available data."
          : cf
              .slice(0, 3)
              .map((f) => f.name)
              .join("; "),
    };
  });

  const hasCritical = findings.some((f) => f.severity === "critical");
  const dataGapScore = categories.find((c) => c.category === "data_gaps")?.score ?? 0;
  const overall = aggregateOverall(categories, hasCritical, dataGapScore);
  const confidence = confidenceFromSources(opts.dataSources, findings.length);

  const topFindings = [...findings]
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
    .slice(0, 8);

  return {
    overall,
    confidence,
    categories,
    topFindings,
    modelVersion: opts.modelVersion ?? process.env.RISK_MODEL_VERSION ?? "1.0.0",
    analyzedAt: new Date().toISOString(),
    lastBlock: opts.lastBlock,
    dataSources: opts.dataSources,
    disclaimer: DISCLAIMER,
  };
}

function severityRank(s: RiskFinding["severity"]): number {
  return { info: 1, low: 2, medium: 3, high: 4, critical: 5 }[s];
}
