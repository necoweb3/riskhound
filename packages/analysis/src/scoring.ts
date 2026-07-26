import {
  aggregateOverall,
  CATEGORY_LABELS,
  confidenceFromSources,
  DISCLAIMER,
  scoreFromFindings,
  type CategoryScore,
  type DataSourceStatus,
  type EvidenceRef,
  type RiskCategoryKey,
  type RiskFinding,
  type RiskReport,
} from "@rugkiller/shared";

/**
 * Rule: showable onchain. A finding that cannot point at a transaction,
 * function or holder record is not a risk signal. It stays visible, but it is
 * reported as a data gap instead of being scored as an observed fact.
 */
function requireEvidence(finding: RiskFinding): RiskFinding {
  if (finding.evidence.length > 0) return finding;
  return {
    ...finding,
    category: "data_gaps",
    status: "theoretical",
    whyItMatters: `${finding.whyItMatters} Reported as a gap because no onchain reference was attached.`,
  };
}

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
  chain?: string;
  tokenAddress?: string;
  buySellFindingHints?: {
    canBuy: boolean | null;
    canSell: boolean | null;
    dataComplete: boolean;
    evidence?: EvidenceRef[];
  };
  deployerHistoryLabel?: "limited_history" | "established" | "unknown";
  deployerAddress?: string | null;
}): RiskReport {
  const findings = [...opts.findings];
  const chain = opts.chain ?? "arc_testnet";
  const tokenRef = (label: string): EvidenceRef[] =>
    opts.tokenAddress
      ? [{ type: "contract", chain, value: opts.tokenAddress, label }]
      : [];

  // Derive buy/sell category findings from simulation hints
  if (opts.buySellFindingHints) {
    const { canBuy, canSell, dataComplete, evidence } = opts.buySellFindingHints;
    const simEvidence = evidence?.length ? evidence : tokenRef("Simulated contract");
    if (canBuy === true && canSell === false) {
      findings.push({
        id: "sim-honeypot",
        category: "buy_sell",
        name: "Sell path failed while buy evidence exists",
        severity: "critical",
        status: "observed",
        summary: "Simulation/history suggests acquisition possible but sell transfer failed.",
        whyItMatters: "Classic honeypot pattern. Users may be unable to exit.",
        evidence: simEvidence,
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
        evidence: simEvidence,
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
      evidence: opts.deployerAddress
        ? [{ type: "address", chain, value: opts.deployerAddress, label: "Deployer wallet" }]
        : tokenRef("Analysed contract"),
      source: "automatic",
    });
  }

  const checked = findings.map(requireEvidence);

  const categories: CategoryScore[] = ALL_CATEGORIES.map((category) => {
    const cf = checked.filter((f) => f.category === category);
    return {
      category,
      score: scoreFromFindings(cf),
      label: CATEGORY_LABELS[category],
      findings: cf,
      // data_gaps is the record of what is missing, so it is complete by
      // definition. Any other category is incomplete once it reports a gap.
      dataComplete:
        category === "data_gaps" ||
        !cf.some((f) => f.name.toLowerCase().includes("incomplete") || f.status === "theoretical"),
      explanation:
        cf.length === 0
          ? "No signals in this category from available data."
          : cf
              .slice(0, 3)
              .map((f) => f.name)
              .join("; "),
    };
  });

  const hasCritical = checked.some((f) => f.severity === "critical");
  const dataGapScore = categories.find((c) => c.category === "data_gaps")?.score ?? 0;
  const overall = aggregateOverall(categories, hasCritical, dataGapScore);
  const incompleteCategories = categories.filter((c) => !c.dataComplete).length;
  const confidence = confidenceFromSources(opts.dataSources, incompleteCategories);

  const topFindings = [...checked]
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
