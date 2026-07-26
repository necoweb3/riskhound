import { describe, expect, it } from "vitest";
import { analyzeHolders } from "./holders.js";
import type { BlockscoutClient } from "@rugkiller/chain";

const BURN = "0x000000000000000000000000000000000000dead";
const ZERO = "0x0000000000000000000000000000000000000000";
const SUPPLY = "1000";

function explorerWith(items: { address: string; value: string }[], complete = true) {
  return {
    getAllTokenHolders: async () => ({ items, complete }),
    getTokenHolders: async () => ({ items, next_page_params: null }),
    getTokenTransfers: async () => ({ items: [] }),
  } as unknown as BlockscoutClient;
}

describe("analyzeHolders", () => {
  it("does not count burned supply as concentration", async () => {
    // 97% burned, the rest spread across ordinary wallets. This is the
    // opposite of a concentrated token and must not be flagged as one.
    const res = await analyzeHolders({
      chain: "arc_testnet",
      token: "0xtoken",
      explorer: explorerWith([
        { address: BURN, value: "900" },
        { address: ZERO, value: "70" },
        { address: "0x1111111111111111111111111111111111111111", value: "10" },
        { address: "0x2222222222222222222222222222222222222222", value: "10" },
        { address: "0x3333333333333333333333333333333333333333", value: "10" },
      ]),
      totalSupply: SUPPLY,
    });

    expect(res.findings.some((f) => f.name === "High top-10 concentration")).toBe(false);
    expect(res.top10Pct).toBeLessThan(80);
  });

  it("does not read exit liquidity as concentration", async () => {
    // The pair holds the float by construction. Counting it flagged every
    // liquid token as highly concentrated and named the pool as the culprit.
    const PAIR = "0x9999999999999999999999999999999999999999";
    const res = await analyzeHolders({
      chain: "arc_testnet",
      token: "0xtoken",
      explorer: explorerWith([
        { address: PAIR, value: "850" },
        { address: "0x1111111111111111111111111111111111111111", value: "60" },
        { address: "0x2222222222222222222222222222222222222222", value: "50" },
        { address: "0x3333333333333333333333333333333333333333", value: "40" },
      ]),
      totalSupply: SUPPLY,
      poolAddresses: [PAIR],
    });

    expect(res.findings.some((f) => f.name === "High top-10 concentration")).toBe(false);
    const pool = res.holders.find((h) => h.address === PAIR);
    expect(pool?.labels).toContain("liquidity_pool");
  });

  it("still flags real concentration held by ordinary wallets", async () => {
    const res = await analyzeHolders({
      chain: "arc_testnet",
      token: "0xtoken",
      explorer: explorerWith([
        { address: "0x1111111111111111111111111111111111111111", value: "990" },
        { address: "0x2222222222222222222222222222222222222222", value: "10" },
      ]),
      totalSupply: SUPPLY,
    });

    const f = res.findings.find((x) => x.name === "High top-10 concentration");
    expect(f?.severity).toBe("critical");
  });

  it("reports incomplete rather than clean when total supply is unknown", async () => {
    const res = await analyzeHolders({
      chain: "arc_testnet",
      token: "0xtoken",
      explorer: explorerWith([
        { address: "0x1111111111111111111111111111111111111111", value: "990" },
      ]),
      totalSupply: null,
    });

    expect(res.dataComplete).toBe(false);
    expect(res.findings.some((f) => f.name === "Holder data incomplete")).toBe(true);
  });

  it("treats a truncated holder list as incomplete", async () => {
    const res = await analyzeHolders({
      chain: "arc_testnet",
      token: "0xtoken",
      explorer: explorerWith(
        [{ address: "0x1111111111111111111111111111111111111111", value: "500" }],
        false
      ),
      totalSupply: SUPPLY,
    });

    // The explorer cursor was still open, so concentration computed from what
    // we have proves nothing about the rest of the holder set.
    expect(res.holderListComplete).toBe(false);
    expect(res.dataComplete).toBe(false);
  });

  it("leaves the deployer share unknown when the deployer is not in the page", async () => {
    const res = await analyzeHolders({
      chain: "arc_testnet",
      token: "0xtoken",
      explorer: explorerWith([
        { address: "0x1111111111111111111111111111111111111111", value: "1000" },
      ]),
      deployer: "0x9999999999999999999999999999999999999999",
      totalSupply: SUPPLY,
    });

    // Zero would read as "the deployer holds nothing", which is a claim we
    // cannot make from a single page of holders.
    expect(res.deployerPct).toBeNull();
  });
});
