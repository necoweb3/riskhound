import { describe, expect, it } from "vitest";
import { isRevert } from "./dex.js";

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
