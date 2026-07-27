import { describe, expect, it } from "vitest";
import { concentrationSignals } from "./observed-mainnet.js";

describe("observed Arc concentration scoring", () => {
  it("raises a critical signal for a dominant holder in the stored index", () => {
    const signals = concentrationSignals([{ pct: 98 }, { pct: 1 }, { pct: 0.5 }]);
    expect(signals.map((signal) => signal.severity)).toContain("critical");
    expect(signals[0].detail).toContain("98.0%");
  });

  it("raises a top-five signal even when no single holder is large", () => {
    const signals = concentrationSignals([{ pct: 18 }, { pct: 18 }, { pct: 18 }, { pct: 18 }, { pct: 18 }]);
    expect(signals.map((signal) => signal.name)).toEqual(["Top-five concentration"]);
  });

  it("reports nothing when the holder index has no percentages, so a gap is never scored as safety", () => {
    expect(concentrationSignals([])).toEqual([]);
    expect(concentrationSignals([{ pct: null }, { pct: null }])).toEqual([]);
  });

  it("reads the largest share regardless of the order the rows arrive in", () => {
    const signals = concentrationSignals([{ pct: 5 }, { pct: 60 }, { pct: null }]);
    expect(signals[0]).toMatchObject({ severity: "critical" });
  });
});
