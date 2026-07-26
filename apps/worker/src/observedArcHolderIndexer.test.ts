import { describe, expect, it } from "vitest";
import { foldBalances, rankHolders } from "./observedArcHolderIndexer.js";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const ZERO = "0x0000000000000000000000000000000000000000";

/** A mint, then A sends 300 to B. */
const HISTORY: [string, bigint][] = [
  [ZERO, -1000n],
  [A, 1000n - 300n],
  [B, 300n],
];

describe("foldBalances", () => {
  it("does not carry stored balances into a full rescan", () => {
    // This is the bug that made a mismatched token unable to recover: the
    // cursor reset forced a rescan from the deploy block while the rows it had
    // already written were still there, so every transfer counted twice.
    const stored: [string, bigint][] = [
      [A, 700n],
      [B, 300n],
    ];

    const doubled = rankHolders(foldBalances(stored, HISTORY));
    expect(doubled.find(([a]) => a === A)?.[1]).toBe(1400n);

    const rescan = rankHolders(foldBalances([], HISTORY));
    expect(rescan.find(([a]) => a === A)?.[1]).toBe(700n);
    expect(rescan.find(([a]) => a === B)?.[1]).toBe(300n);
  });

  it("adds an incremental scan on top of what was stored", () => {
    const stored: [string, bigint][] = [
      [A, 700n],
      [B, 300n],
    ];
    // A sends another 200 to B.
    const next: [string, bigint][] = [
      [A, -200n],
      [B, 200n],
    ];
    const out = foldBalances(stored, next);
    expect(out.get(A)).toBe(500n);
    expect(out.get(B)).toBe(500n);
  });

  it("never reports the zero address as a holder", () => {
    // It is the counterparty of every mint and burn, not an owner of supply.
    const out = foldBalances([], HISTORY);
    expect(out.has(ZERO)).toBe(false);
  });

  it("drops an address that sent everything away", () => {
    const out = rankHolders(foldBalances([[A, 100n]], [[A, -100n]]));
    expect(out.map(([a]) => a)).not.toContain(A);
  });

  it("keeps a burn address out of the mint side but still tracks it", () => {
    // 0x...dEaD is a real balance holder even though nobody controls it, so it
    // must be counted here. Excluding it from concentration is holders.ts's job.
    const dead = "0x000000000000000000000000000000000000dead";
    const out = foldBalances([], [[ZERO, -50n], [dead, 50n]]);
    expect(out.get(dead)).toBe(50n);
  });
});

describe("rankHolders", () => {
  it("orders by balance, largest first", () => {
    const out = rankHolders(new Map([[A, 1n], [B, 9n]]));
    expect(out.map(([a]) => a)).toEqual([B, A]);
  });

  it("breaks ties deterministically so page one does not shuffle", () => {
    const first = rankHolders(new Map([[B, 5n], [A, 5n]]));
    const second = rankHolders(new Map([[A, 5n], [B, 5n]]));
    expect(first).toEqual(second);
  });

  it("excludes a negative balance rather than showing it as a holder", () => {
    // A negative total means a log was missed; it is not a holding.
    const out = rankHolders(new Map([[A, -5n], [B, 5n]]));
    expect(out.map(([a]) => a)).toEqual([B]);
  });
});
