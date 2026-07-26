import { describe, expect, it } from "vitest";
import { buildDeployerProfile } from "./deployer.js";
import type { BlockscoutClient } from "@rugkiller/chain";

function explorerWith(items: unknown[], nextPageParams: unknown = null) {
  return {
    getAddressTransactions: async () => ({ items, next_page_params: nextPageParams }),
    getToken: async () => null,
  } as unknown as BlockscoutClient;
}

const RECENT = new Date(Date.now() - 3600_000).toISOString();

describe("buildDeployerProfile", () => {
  it("does not call a wallet new when the transaction list was truncated", async () => {
    const profile = await buildDeployerProfile({
      chain: "arc_testnet",
      address: "0x1111111111111111111111111111111111111111",
      explorer: explorerWith(
        [{ hash: "0xa", timestamp: RECENT }, { hash: "0xb", timestamp: RECENT }],
        { block_number: 100, index: 3 }
      ),
    });

    // The cursor was still open, so page one says nothing about when this
    // wallet started.
    expect(profile.firstSeenAt).toBeNull();
    expect(profile.ageDays).toBeNull();
    expect(profile.historyLabel).toBe("unknown");
  });

  it("reads age from the oldest transaction once the list is exhausted", async () => {
    const old = new Date(Date.now() - 90 * 24 * 3600_000).toISOString();
    const profile = await buildDeployerProfile({
      chain: "arc_testnet",
      address: "0x1111111111111111111111111111111111111111",
      explorer: explorerWith([{ hash: "0xa", timestamp: RECENT }, { hash: "0xb", timestamp: old }]),
    });

    expect(profile.firstSeenAt).toBe(old);
    expect(profile.historyLabel).toBe("established");
  });

  it("reports unknown history when the transaction list could not be read", async () => {
    const explorer = {
      getAddressTransactions: async () => {
        throw new Error("explorer down");
      },
      getToken: async () => null,
    } as unknown as BlockscoutClient;

    const profile = await buildDeployerProfile({
      chain: "arc_testnet",
      address: "0x1111111111111111111111111111111111111111",
      explorer,
    });

    expect(profile.historyLabel).toBe("unknown");
  });
});
