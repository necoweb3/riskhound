import { describe, expect, it } from "vitest";
import { buildRiskReport } from "./scoring.js";
import type { RiskFinding } from "@rugkiller/shared";

describe("buildRiskReport", () => {
  it("marks critical when honeypot heuristic fires", () => {
    const report = buildRiskReport({
      findings: [],
      dataSources: [
        { key: "arc", name: "Arc", healthy: true, usedInThisAnalysis: true },
      ],
      lastBlock: 1,
      buySellFindingHints: { canBuy: true, canSell: false, dataComplete: true },
    });
    expect(report.overall).toBe("critical_risk");
    expect(report.topFindings.some((f) => f.name.includes("Sell path"))).toBe(true);
  });

  it("includes limited history without calling it low risk", () => {
    const findings: RiskFinding[] = [];
    const report = buildRiskReport({
      findings,
      dataSources: [
        { key: "arc", name: "Arc", healthy: true, usedInThisAnalysis: true },
      ],
      lastBlock: 1,
      tokenAddress: "0xtoken",
      deployerHistoryLabel: "limited_history",
      deployerAddress: "0xdeployer",
    });
    const f = report.categories
      .find((c) => c.category === "deployer_history")
      ?.findings.find((x) => x.name.includes("Limited"));
    expect(f?.summary).toMatch(/little onchain history/i);
    expect(f?.evidence.map((e) => e.value)).toContain("0xdeployer");
  });

  it("reports a finding with no evidence as a gap, not as an observed signal", () => {
    const report = buildRiskReport({
      findings: [
        {
          id: "bare",
          category: "contract",
          name: "Claim without a reference",
          severity: "high",
          status: "observed",
          summary: "s",
          whyItMatters: "w",
          evidence: [],
          source: "automatic",
        },
      ],
      dataSources: [{ key: "arc", name: "Arc", healthy: true, usedInThisAnalysis: true }],
      lastBlock: 1,
    });
    // It must not sit in contract risk pretending to be an observed fact...
    expect(report.categories.find((c) => c.category === "contract")?.findings).toHaveLength(0);
    // ...but it must still be visible.
    const moved = report.categories.find((c) => c.category === "data_gaps")?.findings ?? [];
    expect(moved.map((f) => f.id)).toContain("bare");
    expect(moved[0]?.status).toBe("theoretical");
  });

  it("does not report high confidence while a category is incomplete", () => {
    const report = buildRiskReport({
      findings: [],
      dataSources: [{ key: "arc", name: "Arc", healthy: true, usedInThisAnalysis: true }],
      lastBlock: 1,
      tokenAddress: "0xtoken",
      buySellFindingHints: { canBuy: null, canSell: null, dataComplete: false },
    });
    expect(report.confidence).not.toBe("high");
  });
});
