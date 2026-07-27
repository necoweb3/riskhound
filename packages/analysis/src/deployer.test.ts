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

  it("does not name a funder from a truncated transaction page", async () => {
    const self = "0x1111111111111111111111111111111111111111";
    const profile = await buildDeployerProfile({
      chain: "arc_testnet",
      address: self,
      explorer: explorerWith(
        [
          {
            hash: "0xa",
            timestamp: RECENT,
            from: { hash: "0x2222222222222222222222222222222222222222" },
            to: { hash: self },
          },
        ],
        { block_number: 100, index: 3 }
      ),
    });

    // The oldest inbound row on page one is a recent counterparty, and the
    // funding graph draws firstFunder as a "strong" first-funder edge.
    expect(profile.firstFunder).toBeNull();
  });

  it("names the funder once the transaction list is exhausted", async () => {
    const self = "0x1111111111111111111111111111111111111111";
    const funder = "0x2222222222222222222222222222222222222222";
    const profile = await buildDeployerProfile({
      chain: "arc_testnet",
      address: self,
      explorer: explorerWith([
        { hash: "0xa", timestamp: RECENT, from: { hash: funder }, to: { hash: self } },
      ]),
    });

    expect(profile.firstFunder).toBe(funder);
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
