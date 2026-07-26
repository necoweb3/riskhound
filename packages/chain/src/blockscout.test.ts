import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockscoutClient } from "./blockscout.js";

const client = new BlockscoutClient({
  apiUrl: "https://explorer.test/api",
  v2Url: "https://explorer.test/api/v2",
  chainKey: "test",
  timeoutMs: 1_000,
});

const seen: string[] = [];

/** Serve canned responses per URL and record what was requested. */
function mockFetch(handler: (url: string) => { status?: number; body: unknown }) {
  vi.stubGlobal("fetch", async (input: unknown) => {
    const url = String(input);
    seen.push(url);
    const res = handler(url);
    const status = res.status ?? 200;
    const text = typeof res.body === "string" ? res.body : JSON.stringify(res.body);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
    };
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  seen.length = 0;
});

describe("getLatestBlock", () => {
  it("does not accept a module API error string as a height", async () => {
    // "Deprecated" parses as 0xde under parseInt, so a bare NaN check would let
    // an unreadable explorer be recorded healthy at block 222.
    mockFetch((url) =>
      url.includes("/blocks") ? { status: 500, body: "boom" } : { body: { result: "Deprecated" } }
    );
    await expect(client.getLatestBlock()).resolves.toBeNull();
  });

  it("reads a hex height from the module API fallback", async () => {
    mockFetch((url) =>
      url.includes("/blocks") ? { status: 500, body: "boom" } : { body: { result: "0x1f4" } }
    );
    await expect(client.getLatestBlock()).resolves.toEqual({ number: 500 });
  });
});

describe("getTokenHolders", () => {
  it("surfaces explorer failures instead of reporting an empty holder set", async () => {
    mockFetch(() => ({ status: 404, body: "not found" }));
    await expect(client.getTokenHolders("0xabc")).rejects.toThrow();
  });

  it("echoes null page params back so paging does not restart at page one", async () => {
    mockFetch(() => ({ body: { items: [], next_page_params: null } }));
    await client.getTokenHolders("0xabc", { items_count: 50, value: null });
    expect(seen[0]).toContain("items_count=50");
    expect(seen[0]).toContain("value=null");
  });
});

describe("getContractCreation", () => {
  it("does not read a character out of the module API error string", async () => {
    mockFetch(() => ({ body: { status: "0", message: "NOTOK", result: "No data found" } }));
    await expect(client.getContractCreation("0xabc")).resolves.toBeNull();
  });
});
