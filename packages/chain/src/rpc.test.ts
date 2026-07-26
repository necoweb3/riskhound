import { describe, expect, it } from "vitest";
import { detectProxyHints, scanSelectors } from "./rpc.js";

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

  it("detects EIP-1967 proxy slot", () => {
    const slot = "360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
    const code = ("0x" + slot) as `0x${string}`;
    const r = detectProxyHints(code);
    expect(r.isProxy).toBe(true);
  });
});
