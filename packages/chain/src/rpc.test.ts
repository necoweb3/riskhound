import { describe, expect, it } from "vitest";
import { detectProxyHints, scanSelectors } from "./rpc.js";

describe("bytecode scanning", () => {
  it("detects mint selector", () => {
    const code = ("0x" + "00".repeat(20) + "40c10f19" + "00".repeat(20)) as `0x${string}`;
    const found = scanSelectors(code);
    expect(found.some((f) => f.selector === "40c10f19")).toBe(true);
  });

  it("detects EIP-1967 proxy slot", () => {
    const slot = "360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
    const code = ("0x" + slot) as `0x${string}`;
    const r = detectProxyHints(code);
    expect(r.isProxy).toBe(true);
  });
});
