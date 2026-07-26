import { describe, expect, it } from "vitest";
import { buildFundingGraph } from "./graph.js";
import type { CrossChainLink } from "@rugkiller/shared";

const DEPLOYER = "0x1111111111111111111111111111111111111111";

function identityLink(): CrossChainLink {
  return {
    id: "definitive-arc-rh",
    strength: "definitive",
    fromChain: "arc_testnet",
    toChain: "robinhood",
    fromAddress: DEPLOYER,
    toAddress: DEPLOYER,
    reason: "Same wallet address observed on both chains.",
    evidence: [{ type: "address", chain: "arc_testnet", value: DEPLOYER }],
    relatedEventIds: [],
  };
}

describe("buildFundingGraph", () => {
  it("does not place a wallet at distance zero for merely existing on another chain", () => {
    const graph = buildFundingGraph({
      tokenAddress: "0xtoken",
      deployer: DEPLOYER,
      links: [identityLink()],
    });

    const row = graph.hopsToRisk.find((h) => h.address === DEPLOYER);
    expect(row?.hops).toBeNull();
  });

  it("places a wallet at distance zero when the link carries a reviewed risk event", () => {
    const graph = buildFundingGraph({
      tokenAddress: "0xtoken",
      deployer: DEPLOYER,
      links: [{ ...identityLink(), strength: "strong", relatedEventIds: ["event-1"] }],
    });

    expect(graph.hopsToRisk.find((h) => h.address === DEPLOYER)?.hops).toBe(0);
  });

  it("reports one row per address even when the address has a node per chain", () => {
    const graph = buildFundingGraph({
      tokenAddress: "0xtoken",
      deployer: DEPLOYER,
      links: [identityLink()],
    });

    const addresses = graph.hopsToRisk.map((h) => h.address);
    expect(new Set(addresses).size).toBe(addresses.length);
  });

  it("measures hops over the edges it actually returns", () => {
    const risky = "0x2222222222222222222222222222222222222222";
    const graph = buildFundingGraph({
      tokenAddress: "0xtoken",
      deployer: DEPLOYER,
      firstFunder: risky,
      links: [
        {
          ...identityLink(),
          id: "risk-link",
          strength: "strong",
          fromAddress: risky,
          toAddress: risky,
          relatedEventIds: ["event-1"],
        },
      ],
    });

    const edgeIds = new Set(graph.edges.map((e) => e.id));
    const hop = graph.hopsToRisk.find((h) => h.address === DEPLOYER);
    expect(hop?.hops).toBe(1);
    // The funding edge that supports the 1-hop answer survived pruning.
    expect(edgeIds.has(`funded-wallet:arc_testnet:${risky}-wallet:arc_testnet:${DEPLOYER}`)).toBe(true);
  });
});
