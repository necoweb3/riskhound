import { describe, expect, it } from "vitest";
import { aggregateOverall, scoreFromFindings, type CategoryScore, type RiskFinding } from "./risk.js";

function finding(severity: RiskFinding["severity"]): RiskFinding {
  return {
    id: "1",
    category: "contract",
    name: "test",
    severity,
    status: "theoretical",
    summary: "s",
    whyItMatters: "w",
    evidence: [],
    source: "automatic",
  };
}

describe("risk scoring", () => {
  it("does not bury critical findings in averages", () => {
    const cats: CategoryScore[] = [
      {
        category: "contract",
        score: 95,
        label: "Contract risk",
        findings: [finding("critical")],
        dataComplete: true,
        explanation: "mint authority present",
      },
      {
        category: "liquidity",
        score: 10,
        label: "Liquidity risk",
        findings: [],
        dataComplete: true,
        explanation: "ok",
      },
    ];
    expect(aggregateOverall(cats, true, 0)).toBe("critical_risk");
  });

  it("returns insufficient_data when nothing usable", () => {
    expect(aggregateOverall([], false, 90)).toBe("insufficient_data");
  });

  it("scores critical findings high", () => {
    expect(scoreFromFindings([finding("critical")])).toBeGreaterThanOrEqual(90);
  });
});
