import { describe, expect, it } from "vitest";
import { toFunctionSelector } from "viem";
import { detectProxyHints, RISK_SELECTORS, scanSelectors, STANDARD_SELECTORS } from "./rpc.js";

describe("selector tables", () => {
  it("keys every entry by the hash of its own signature", () => {
    // A key that does not hash to its label makes the product name a privileged
    // function it never found, and the selector in the evidence ref then fails
    // to check out against the signature printed beside it.
    for (const table of [RISK_SELECTORS, STANDARD_SELECTORS]) {
      for (const [selector, signature] of Object.entries(table)) {
        expect(`${signature} -> ${selector}`).toBe(
          `${signature} -> ${toFunctionSelector(signature).slice(2)}`
        );
      }
    }
  });

  it("keeps mandatory ERC-20 and read-only functions out of the risk table", () => {
    for (const signature of Object.values(RISK_SELECTORS)) {
      expect([
        "transfer(address,uint256)",
        "transferFrom(address,address,uint256)",
        "balanceOf(address)",
        "totalSupply()",
        "owner()",
        "admin()",
        "implementation()",
      ]).not.toContain(signature);
    }
  });
});

describe("bytecode scanning", () => {
  it("detects mint selector pushed by the dispatcher", () => {
    const code = ("0x" + "00".repeat(20) + "63" + "40c10f19" + "00".repeat(20)) as `0x${string}`;
    const found = scanSelectors(code);
    expect(found.some((f) => f.selector === "40c10f19")).toBe(true);
  });

  it("ignores selector bytes that are never pushed", () => {
    // The same four bytes inside a constant or metadata are not a callable
    // function, and reporting them invented mint authority findings.
    const code = ("0x" + "00".repeat(20) + "40c10f19" + "00".repeat(20)) as `0x${string}`;
    const found = scanSelectors(code);
    expect(found.some((f) => f.selector === "40c10f19")).toBe(false);
  });

  it("ignores a PUSH4 match that straddles byte boundaries", () => {
    const code = ("0x" + "00".repeat(4) + "06340c10f190" + "00".repeat(4)) as `0x${string}`;
    const found = scanSelectors(code);
    expect(found.some((f) => f.selector === "40c10f19")).toBe(false);
  });

  it("ignores an upgradeTo selector the dispatcher never pushes", () => {
    const code = ("0x" + "00".repeat(20) + "3659cfe6" + "00".repeat(20)) as `0x${string}`;
    expect(detectProxyHints(code).isProxy).toBe(false);
  });

  it("detects a pushed upgradeTo selector", () => {
    const code = ("0x" + "00".repeat(20) + "63" + "3659cfe6" + "00".repeat(20)) as `0x${string}`;
    expect(detectProxyHints(code).isProxy).toBe(true);
  });

  it("detects EIP-1967 proxy slot", () => {
    const slot = "360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
    const code = ("0x" + slot) as `0x${string}`;
    const r = detectProxyHints(code);
    expect(r.isProxy).toBe(true);
  });
});
