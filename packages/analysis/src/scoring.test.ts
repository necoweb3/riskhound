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
      deployerHistoryLabel: "limited_history",
    });
    const f = report.categories
      .find((c) => c.category === "deployer_history")
      ?.findings.find((x) => x.name.includes("Limited"));
    expect(f?.summary).toMatch(/little onchain history/i);
  });
});
