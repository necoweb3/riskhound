import { describe, expect, it } from "vitest";
import type { BlockscoutClient } from "@rugkiller/chain";
import { compareCrossChain } from "./crosschain.js";

const creator = "0x1111111111111111111111111111111111111111";

function explorerWithActivity(): BlockscoutClient {
  return {
    getAddress: async () => ({ coin_balance: "1", is_contract: false }),
    getAddressTransactions: async () => ({ items: [] }),
  } as unknown as BlockscoutClient;
}

describe("outside-chain creator evidence", () => {
  it("does not turn ordinary activity into an Arc risk finding", async () => {
    const explorer = explorerWithActivity();
    const result = await compareCrossChain({
      arcAddress: creator,
      arcExplorer: explorer,
      rhExplorer: explorer,
      rhRiskEvents: [],
    });

    expect(result.links.length).toBeGreaterThan(0);
    expect(result.findings).toEqual([]);
  });

  it("surfaces a creator warning only when a risk event has evidence", async () => {
    const explorer = explorerWithActivity();
    const result = await compareCrossChain({
      arcAddress: creator,
      arcExplorer: explorer,
      rhExplorer: explorer,
      rhRiskEvents: [
        {
          id: "event-1",
          chain: "robinhood",
          eventClass: "high_risk_exit",
          title: "Liquidity removed after launch",
          addresses: [creator],
          confidence: "high",
          autoDetected: false,
          manualStatus: "confirmed",
          occurredAt: "2026-07-20T00:00:00.000Z",
          evidence: [
            {
              type: "tx",
              chain: "robinhood",
              value: "0xabc",
              url: "https://robinhoodchain.blockscout.com/tx/0xabc",
            },
          ],
        },
      ],
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.category).toBe("cross_chain");
    expect(result.links.some((link) => link.relatedEventIds.includes("event-1"))).toBe(true);
  });
});
