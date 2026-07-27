import { describe, expect, it } from "vitest";
import { analyzeApexiSwap, isRevert } from "./dex.js";
import type { BlockscoutClient, PublicClient } from "@rugkiller/chain";
import type { Address } from "viem";

/**
 * canSell === false is the honeypot verdict. It may only come from a proven
 * revert, never from a node that failed to answer, so anything ambiguous has
 * to classify as "not a revert".
 */
describe("isRevert", () => {
  it("treats a proven revert as evidence about the token", () => {
    expect(isRevert(new Error("execution reverted"))).toBe(true);
    expect(isRevert(new Error("execution reverted: TRANSFER_FAILED"))).toBe(true);
    expect(isRevert(new Error("reverted with reason string 'blacklisted'"))).toBe(true);
    expect(isRevert(new Error("invalid opcode"))).toBe(true);
    expect(isRevert({ code: 3, message: "revert" })).toBe(true);
    expect(isRevert({ cause: { code: 3 }, message: "call failed" })).toBe(true);
  });

  it("never reads a transport failure as a failed sell", () => {
    const timeout = new Error("The request took too long");
    timeout.name = "TimeoutError";
    expect(isRevert(timeout)).toBe(false);

    const http = new Error("HTTP request failed: 429 Too Many Requests");
    http.name = "HttpRequestError";
    expect(isRevert(http)).toBe(false);

    expect(isRevert(new Error("fetch failed"))).toBe(false);
    expect(isRevert(new Error("connect ECONNREFUSED 127.0.0.1:8545"))).toBe(false);
    expect(isRevert(new Error("socket hang up"))).toBe(false);
    expect(isRevert(new Error("503 Service Unavailable"))).toBe(false);
    expect(isRevert(new Error("rate limit exceeded"))).toBe(false);
  });

  it("does not read the RPC host out of the message as a transport failure", () => {
    // viem puts `URL: <rpcUrl>` into every raw eth_call error, and every Arc
    // endpoint is on the .network TLD. A bare "network" match turned real
    // reverts into "not tested" and made the honeypot rule unreachable.
    const e = new Error(
      "RPC Request failed.\n\nURL: https://rpc.drpc.testnet.arc.network\nRequest body: {}\n\nDetails: execution reverted"
    );
    e.name = "RpcRequestError";
    expect(isRevert(e)).toBe(true);
  });

  it("still reads a real network error as a transport failure", () => {
    expect(isRevert(new Error("network error while sending request"))).toBe(false);
    expect(isRevert(new Error("NetworkError when attempting to fetch resource"))).toBe(false);
  });

  it("defaults to not-a-revert for anything it does not recognise", () => {
    expect(isRevert(new Error("something entirely unexpected"))).toBe(false);
    expect(isRevert(undefined)).toBe(false);
    expect(isRevert(null)).toBe(false);
    expect(isRevert("")).toBe(false);
  });

  it("does not let a transport message win because it mentions a revert", () => {
    // A node error that quotes the word is still a node error if it also
    // reports a transport condition.
    const e = new Error("HTTP 429 too many requests while estimating; execution reverted");
    expect(isRevert(e)).toBe(false);
  });
});

const TOKEN = "0x1111111111111111111111111111111111111111" as Address;
const PAIR = "0x2222222222222222222222222222222222222222";
const DEAD = "0x000000000000000000000000000000000000dead";

/** Reserves are zero so the round-trip simulation is never reached. */
function rpcWithPair(): PublicClient {
  return {
    readContract: async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case "getPair":
          return PAIR;
        case "token0":
          return TOKEN;
        case "token1":
          return "0x911b4000D3422F482F4062a913885f7b035382Df";
        case "getReserves":
          return [0n, 0n, 0];
        default:
          throw new Error(`unexpected call: ${functionName}`);
      }
    },
  } as unknown as PublicClient;
}

/**
 * "Burned" is the reassuring answer about a pool, so it may only come from LP
 * records that were actually read.
 */
describe("analyzeApexiSwap LP burn share", () => {
  it("reports the burned share as unknown when the holder list did not answer", async () => {
    const explorer = {
      getToken: async () => ({ total_supply: "1000000" }),
      getTokenHolders: async () => {
        throw new Error("explorer down");
      },
      getTokenTransfers: async () => ({ items: [] }),
    } as unknown as BlockscoutClient;

    const res = await analyzeApexiSwap({
      chain: "arc_testnet",
      token: TOKEN,
      rpc: rpcWithPair(),
      explorer,
    });

    expect(res.pair?.burned).toBeNull();
    expect(res.lpDataComplete).toBe(false);
  });

  it("reports the burned share once supply and holders were both read", async () => {
    const explorer = {
      getToken: async () => ({ total_supply: "1000000" }),
      getTokenHolders: async () => ({
        items: [
          { address: DEAD, value: "950000" },
          { address: "0x3333333333333333333333333333333333333333", value: "50000" },
        ],
      }),
      getTokenTransfers: async () => ({ items: [] }),
    } as unknown as BlockscoutClient;

    const res = await analyzeApexiSwap({
      chain: "arc_testnet",
      token: TOKEN,
      rpc: rpcWithPair(),
      explorer,
    });

    expect(res.pair?.burned).toBe(true);
    expect(res.lpDataComplete).toBe(true);
  });
});

/** Reserves are non-zero, so the router quote decides the buy verdict. */
function rpcWithLiquidity(quote: () => unknown): PublicClient {
  return {
    readContract: async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case "getPair":
          return PAIR;
        case "token0":
          return TOKEN;
        case "token1":
          return "0x911b4000D3422F482F4062a913885f7b035382Df";
        case "getReserves":
          return [1_000n, 1_000n, 0];
        case "getAmountsOut":
          return quote();
        default:
          throw new Error(`unexpected call: ${functionName}`);
      }
    },
    chain: { id: 5042002 },
  } as unknown as PublicClient;
}

const emptyLpExplorer = {
  getToken: async () => null,
  getTokenHolders: async () => ({ items: [] }),
  getTokenTransfers: async () => ({ items: [] }),
} as unknown as BlockscoutClient;

describe("analyzeApexiSwap buy verdict", () => {
  it("leaves the buy path unknown when the router quote never answered", async () => {
    const res = await analyzeApexiSwap({
      chain: "arc_testnet",
      token: TOKEN,
      rpc: rpcWithLiquidity(() => {
        const e = new Error("HTTP request failed: 429 Too Many Requests");
        e.name = "HttpRequestError";
        throw e;
      }),
      explorer: emptyLpExplorer,
      skipSimulation: true,
    });

    // A rate-limited node tested nothing. "Cannot buy" would be a claim about
    // the token drawn from a claim about the transport.
    expect(res.simulation.canBuy).toBeNull();
  });

  it("reports a proven revert on the quote as a failed buy", async () => {
    const res = await analyzeApexiSwap({
      chain: "arc_testnet",
      token: TOKEN,
      rpc: rpcWithLiquidity(() => {
        throw new Error("execution reverted: INSUFFICIENT_LIQUIDITY");
      }),
      explorer: emptyLpExplorer,
      skipSimulation: true,
    });

    expect(res.simulation.canBuy).toBe(false);
  });

  it("reports an answered quote as a buyable path", async () => {
    const res = await analyzeApexiSwap({
      chain: "arc_testnet",
      token: TOKEN,
      rpc: rpcWithLiquidity(() => [10n, 20n]),
      explorer: emptyLpExplorer,
      skipSimulation: true,
    });

    expect(res.simulation.canBuy).toBe(true);
    // skipSimulation must not let an unrun round trip claim a sell path.
    expect(res.simulation.canSell).toBeNull();
    expect(res.simulation.dataComplete).toBe(false);
  });
});
