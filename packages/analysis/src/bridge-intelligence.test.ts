import { describe, expect, it } from "vitest";
import { assessArcInboundTransfer } from "./bridge-intelligence.js";

const burn = {
  sourceChain: "base",
  sourceTxHash: "0xburn",
  sourceWallet: "0x1111111111111111111111111111111111111111",
  arcRecipient: "0x2222222222222222222222222222222222222222",
  amountUsdc: "50000",
  destinationDomain: 26,
  burnObservedAt: "2026-07-20T00:00:00.000Z",
};

describe("Arc inbound CCTP assessment", () => {
  it("never calls a burn-only observation completed", () => {
    const result = assessArcInboundTransfer(burn, {
      now: new Date("2026-07-20T00:10:00.000Z"),
    });
    expect(result.status).toBe("source_burn_observed");
    expect(result.completed).toBe(false);
  });

  it("requires an Arc mint transaction for completion", () => {
    const result = assessArcInboundTransfer({
      ...burn,
      attestationHash: "0xattestation",
      arcMintTxHash: "0xmint",
    });
    expect(result.status).toBe("arc_mint_confirmed");
    expect(result.completed).toBe(true);
    expect(result.evidence.some((item) => item.chain === "arc_testnet")).toBe(true);
  });

  it("marks stale burn-only observations unresolved", () => {
    const result = assessArcInboundTransfer(burn, {
      now: new Date("2026-07-21T00:00:00.000Z"),
    });
    expect(result.status).toBe("unresolved");
    expect(result.completed).toBe(false);
  });
});
