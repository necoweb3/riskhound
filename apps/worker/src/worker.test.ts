import { describe, expect, it } from "vitest";
import { runArcDiscovery } from "./arcDiscovery.js";
import { runAlertEngine } from "./alerts.js";
import { loadRhAndAnalyze } from "./analyzeJob.js";
import { canRetireSignature, normalizeArcRecipient } from "./solanaCctpIndexer.js";

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

describe("canRetireSignature", () => {
  const now = 1_700_000_000_000;
  const at = (secondsAgo: number) => ({ signature: "s", blockTime: now / 1000 - secondsAgo });

  it("keeps asking about a signature Circle may not have indexed yet", () => {
    expect(canRetireSignature(at(60), now)).toBe(false);
  });

  it("retires one Circle has had time to index", () => {
    expect(canRetireSignature(at(30 * 60), now)).toBe(true);
  });

  it("keeps a signature the ledger has not timestamped yet", () => {
    // It is the newest kind of signature there is, so treating a missing
    // blockTime as 1970 dropped it from the backfill for good.
    expect(canRetireSignature({ signature: "s" }, now)).toBe(false);
    expect(canRetireSignature({ signature: "s", blockTime: null }, now)).toBe(false);
  });

  it("retires a failed transaction, which can never carry a burn", () => {
    expect(canRetireSignature({ signature: "s", err: {} }, now)).toBe(true);
  });
});
