import { describe, expect, it } from "vitest";
import { runArcDiscovery } from "./arcDiscovery.js";
import { runAlertEngine } from "./alerts.js";
import { loadRhAndAnalyze } from "./analyzeJob.js";
import { normalizeArcRecipient } from "./solanaCctpIndexer.js";

describe("worker entry points", () => {
  it("exports callable discovery, analysis and alert jobs", () => {
    expect(typeof runArcDiscovery).toBe("function");
    expect(typeof loadRhAndAnalyze).toBe("function");
    expect(typeof runAlertEngine).toBe("function");
  });

  it("normalizes a CCTP bytes32 recipient to an Arc address", () => {
    expect(normalizeArcRecipient("0x000000000000000000000000C1fd4cd1858c6BD7eFa96f239E04cC46dA84A69C"))
      .toBe("0xc1fd4cd1858c6bd7efa96f239e04cc46da84a69c");
    expect(normalizeArcRecipient("not-an-address")).toBe("unknown");
  });
});
