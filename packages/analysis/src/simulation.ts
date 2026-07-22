import type { SimulationResult, SimulationStep, EvidenceRef } from "@rugkiller/shared";
import type { BlockscoutClient } from "@rugkiller/chain";
import { ethCall, type PublicClient } from "@rugkiller/chain";
import {
  encodeFunctionData,
  type Address,
  type Hex,
  parseAbi,
} from "viem";

const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function transferFrom(address,address,uint256) returns (bool)",
]);

export interface SimulationInput {
  chain: string;
  token: Address;
  rpc: PublicClient | null;
  explorer: BlockscoutClient;
  /** Optional known router / pair for deeper sims later */
  router?: Address;
  pair?: Address;
}

/**
 * Non-custodial buy/sell path probing.
 * Uses eth_call + historical transfer behavior from explorer.
 * Does NOT spend funds or require user keys.
 */
export async function simulateBuySell(input: SimulationInput): Promise<SimulationResult> {
  const steps: SimulationStep[] = [];
  const now = new Date().toISOString();
  let canBuy: boolean | null = null;
  let canSell: boolean | null = null;
  let buyTaxBps: number | null = null;
  let sellTaxBps: number | null = null;
  let method: SimulationResult["method"] = "hybrid";
  let dataComplete = false;

  // 1) Historical transfers as behavioral evidence
  try {
    const transfers = await input.explorer.getTokenTransfers(input.token);
    const items = transfers.items ?? [];
    steps.push({
      step: "Load historical token transfers",
      success: true,
      detail: `Fetched ${items.length} recent transfers from explorer`,
      evidence: items.slice(0, 3).map(
        (t): EvidenceRef => ({
          type: "tx",
          chain: input.chain,
          value: t.transaction_hash,
        })
      ),
    });

    // crude: if we see transfers to many EOAs after deployment, buys likely worked historically
    if (items.length > 0) {
      canBuy = true;
      steps.push({
        step: "Historical buy evidence",
        success: true,
      detail: "At least one token transfer was observed. The token has moved between addresses.",
      });
    } else {
      steps.push({
        step: "Historical buy evidence",
        success: false,
      detail: "No transfers found yet. Tradability cannot be confirmed from history.",
        error: "insufficient_history",
      });
    }

    // Detect possible sell blocks: many failed txs would need RPC receipt scan;
    // For now mark incomplete if we only have transfers one-way from deployer-like patterns.
  } catch (e) {
    steps.push({
      step: "Load historical token transfers",
      success: false,
      detail: "Explorer transfer history unavailable",
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // 2) eth_call transfer simulation from a random EOA with 0 balance should fail predictably
  if (input.rpc) {
    method = "hybrid";
    const dummyFrom = "0x1111111111111111111111111111111111111111" as Address;
    const dummyTo = "0x2222222222222222222222222222222222222222" as Address;

    try {
      const bal = await input.rpc.readContract({
        address: input.token,
        abi: ERC20,
        functionName: "balanceOf",
        args: [dummyFrom],
      });
      steps.push({
        step: "Read dummy balance",
        success: true,
        detail: `balanceOf(dummy)=${bal.toString()}`,
      });
    } catch (e) {
      steps.push({
        step: "Read balanceOf",
        success: false,
        detail: "Token may not implement standard ERC-20 balanceOf",
        error: e instanceof Error ? e.message : String(e),
      });
    }

    // Probe transfer selector exists via call
    const transferData = encodeFunctionData({
      abi: ERC20,
      functionName: "transfer",
      args: [dummyTo, 1n],
    });

    const callRes = await ethCall(input.rpc, {
      to: input.token,
      data: transferData as Hex,
      from: dummyFrom,
    });

    if (callRes.success) {
      steps.push({
        step: "eth_call transfer(dummy)",
        success: true,
        detail:
        "The call did not revert for a zero-balance sender, or the token returned success. Inspect carefully.",
      });
      // Not enough to mark canSell true
    } else {
      const err = callRes.error ?? "";
      const expected =
        /insufficient|balance|transfer amount|exceeds|ERC20/i.test(err) ||
        err.length > 0;
      steps.push({
        step: "eth_call transfer(dummy)",
        success: expected,
        detail: expected
          ? "Transfer reverted as expected for empty balance (standard ERC-20 behavior)."
          : "Transfer probe failed with unexpected error.",
        error: err.slice(0, 300),
      });
    }

    // Try to find a holder with balance for more realistic sell probe
    try {
      const holders = await input.explorer.getTokenHolders(input.token);
      const first = holders.items?.[0];
      const holderAddr =
        first && typeof first.address === "string"
          ? first.address
          : first && typeof first.address === "object"
            ? first.address.hash
            : null;

      if (holderAddr && first?.value && BigInt(first.value) > 0n) {
        const holder = holderAddr as Address;
        const amount = BigInt(first.value) / 1000n || 1n; // 0.1%
        const sellData = encodeFunctionData({
          abi: ERC20,
          functionName: "transfer",
          args: [dummyTo, amount],
        });
        const sellCall = await ethCall(input.rpc, {
          to: input.token,
          data: sellData as Hex,
          from: holder,
        });
        if (sellCall.success) {
          canSell = true;
          steps.push({
            step: "eth_call transfer from top holder",
            success: true,
            detail: `Simulated transfer of ${amount.toString()} from holder ${holder} did not revert.`,
            evidence: [{ type: "address", chain: input.chain, value: holder, label: "holder" }],
          });
        } else {
          // Could be honeypot OR missing allowance OR non-standard hooks requiring DEX path
          const msg = sellCall.error ?? "";
          const maybeHoneypot = /blacklist|not whitelisted|trading|swap|sell/i.test(msg);
          canSell = maybeHoneypot ? false : null;
          steps.push({
            step: "eth_call transfer from top holder",
            success: false,
            detail: maybeHoneypot
      ? "Transfer from holder reverted with a trading or restriction-related reason. Possible honeypot or blacklist."
      : "Transfer from holder reverted. It may require a DEX router path or have custom hooks. This alone is not conclusive.",
            error: msg.slice(0, 400),
            evidence: [{ type: "address", chain: input.chain, value: holder, label: "holder" }],
          });
          if (maybeHoneypot) {
            steps.push({
              step: "Honeypot heuristic",
              success: false,
              detail: "Restriction-like revert detected on holder transfer simulation.",
            });
          }
        }
        dataComplete = canSell !== null || canBuy !== null;
      } else {
        steps.push({
          step: "Holder-based sell probe",
          success: false,
          detail: "No holders with balance available for realistic sell simulation.",
          error: "no_holders",
        });
      }
    } catch (e) {
      steps.push({
        step: "Holder-based sell probe",
        success: false,
        detail: "Could not load holders for sell simulation",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  } else {
    steps.push({
      step: "RPC simulation",
      success: false,
      detail: "No RPC is configured. Simulation is limited to explorer history.",
      error: "rpc_unavailable",
    });
    method = "historical_tx";
  }

  // Tax estimation requires swap quotes; leave null unless we have router depth later
  const failed = steps.filter((s) => !s.success);
  const summaryParts: string[] = [];
  if (canBuy === true) summaryParts.push("Buy path historically observed");
  else if (canBuy === false) summaryParts.push("Buy path failed");
  else summaryParts.push("Buy path inconclusive");
  if (canSell === true) summaryParts.push("sell transfer simulation succeeded");
  else if (canSell === false) summaryParts.push("sell transfer simulation failed (possible restriction)");
  else summaryParts.push("sell path inconclusive");
  if (failed.length) summaryParts.push(`${failed.length} step(s) incomplete or failed`);

  return {
    canBuy,
    canSell,
    buyTaxBps,
    sellTaxBps,
    steps,
    summary: summaryParts.join("; ") + ".",
    simulatedAt: now,
    method,
    dataComplete,
  };
}
