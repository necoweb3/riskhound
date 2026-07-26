import { describe, expect, it } from "vitest";
import { analyzeLiquidity } from "./liquidity.js";
import type { BlockscoutClient } from "@rugkiller/chain";

function explorerWith(items: unknown[]) {
  return {
    getToken: async () => null,
    getTokenTransfers: async () => ({ items }),
  } as unknown as BlockscoutClient;
}

describe("analyzeLiquidity", () => {
  it("does not read an ordinary token mint or burn as a pool event", async () => {
    const res = await analyzeLiquidity({
      chain: "arc_testnet",
      token: "0xtoken",
      explorer: explorerWith([
        { transaction_hash: "0xa", method: "mint", timestamp: "2024-01-01T00:00:00Z" },
        { transaction_hash: "0xb", method: "burn", timestamp: "2024-01-02T00:00:00Z" },
      ]),
    });

    expect(res.snapshot.recentAdds).toHaveLength(0);
    expect(res.snapshot.recentRemoves).toHaveLength(0);
    expect(res.findings.some((f) => f.name === "Multiple liquidity-remove-like events")).toBe(false);
  });

  it("still records explicit liquidity methods", async () => {
    const res = await analyzeLiquidity({
      chain: "arc_testnet",
      token: "0xtoken",
      explorer: explorerWith([
        { transaction_hash: "0xa", method: "addLiquidity", timestamp: "2024-01-01T00:00:00Z" },
        { transaction_hash: "0xb", method: "removeLiquidity", timestamp: "2024-01-02T00:00:00Z" },
      ]),
    });

    expect(res.snapshot.recentAdds).toHaveLength(1);
    expect(res.snapshot.recentRemoves).toHaveLength(1);
  });

  it("leaves an event time unknown instead of stamping it with the analysis time", async () => {
    const res = await analyzeLiquidity({
      chain: "arc_testnet",
      token: "0xtoken",
      explorer: explorerWith([{ transaction_hash: "0xa", method: "removeLiquidity" }]),
    });

    expect(res.snapshot.recentRemoves[0]?.timestamp).toBeNull();
  });

  it("does not name the deployer as the LP controller without evidence", async () => {
    const res = await analyzeLiquidity({
      chain: "arc_testnet",
      token: "0xtoken",
      explorer: explorerWith([]),
      deployer: "0x9999999999999999999999999999999999999999",
    });

    expect(res.snapshot.dominantController).toBeNull();
  });
});
