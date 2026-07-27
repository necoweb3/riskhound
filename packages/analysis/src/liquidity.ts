import type {
  EvidenceRef,
  LiquidityPool,
  LiquiditySnapshot,
  RiskFinding,
  TimelineEvent,
} from "@rugkiller/shared";
import type { BlockscoutClient } from "@rugkiller/chain";
import type { PreloadedTransfers } from "./holders.js";

/**
 * Liquidity analysis using explorer transfer/log heuristics.
 * When DEX pool registries are known for Arc, they should be added to network config.
 */
export async function analyzeLiquidity(opts: {
  chain: string;
  token: string;
  explorer: BlockscoutClient;
  deployer?: string | null;
  /**
   * Token exchange rate already read for this token earlier in the same
   * analysis. Supplied (even as null) means the token page was fetched
   * elsewhere and must not be fetched a second time.
   */
  exchangeRate?: string | null;
  /** Transfer page already read for this token earlier in the same analysis. */
  transfers?: PreloadedTransfers;
}): Promise<{ snapshot: LiquiditySnapshot; findings: RiskFinding[]; errors: string[] }> {
  const findings: RiskFinding[] = [];
  const errors: string[] = [];
  const pools: LiquidityPool[] = [];
  const recentAdds: TimelineEvent[] = [];
  const recentRemoves: TimelineEvent[] = [];
  const notes: string[] = [];

  // Discover pairs via token transfers involving known pair-like contracts is hard without registry.
  // Use token page exchange data if present + transfer patterns labeled Mint/Burn if decoded.
  if (opts.exchangeRate !== undefined) {
    if (opts.exchangeRate) notes.push(`Explorer exchange_rate=${opts.exchangeRate}`);
  } else {
    try {
      const token = await opts.explorer.getToken(opts.token);
      if (token?.exchange_rate) {
        notes.push(`Explorer exchange_rate=${token.exchange_rate}`);
      }
    } catch (e) {
      errors.push(`token: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const transfersResult: PreloadedTransfers = opts.transfers
    ? opts.transfers
    : await opts.explorer
        .getTokenTransfers(opts.token)
        .then((page) => ({ ok: true as const, page }))
        .catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));

  if (transfersResult.ok) {
    let i = 0;
    for (const t of transfersResult.page.items ?? []) {
      const method = (t.method ?? t.type ?? "").toLowerCase();
      const tx = t.transaction_hash;
      // The chain timestamp is the only honest value here. Falling back to the
      // analysis time dated the event to when it was looked at, so an unknown
      // time stays null; TimelineEvent.timestamp is still typed string upstream.
      const ts = t.timestamp ?? null;
      const from = typeof t.from === "string" ? t.from : t.from?.hash;
      const to = typeof t.to === "string" ? t.to : t.to?.hash;

      // A "mint" or "burn" of the token itself is an ordinary supply change,
      // not a pool event, so only an explicit liquidity method counts here.
      if (/add.?liquidity/i.test(method)) {
        recentAdds.push({
          id: `add-${tx}-${i}`,
          type: "liquidity_add",
          timestamp: ts,
          chain: opts.chain,
          title: "Possible liquidity add",
          detail: method,
          txHash: tx,
          addresses: [from, to].filter(Boolean) as string[],
        });
      }
      if (/remove.?liquidity/i.test(method)) {
        recentRemoves.push({
          id: `rm-${tx}-${i}`,
          type: "liquidity_remove",
          timestamp: ts,
          chain: opts.chain,
          title: "Possible liquidity remove",
          detail: method,
          txHash: tx,
          addresses: [from, to].filter(Boolean) as string[],
          severity: "high",
        });
      }
      i++;
    }
  } else {
    errors.push(`transfers: ${transfersResult.error}`);
  }

  if (pools.length === 0) {
    notes.push(
      "No verified DEX pool registry match for this token yet. Liquidity USD may be unavailable."
    );
    findings.push({
      id: `liq-unknown-${opts.token}`,
      category: "liquidity",
      name: "Liquidity pool data incomplete",
      severity: "medium",
      status: "observed",
      summary: "Could not map token to verified pools with reserve values.",
      whyItMatters: "Exit liquidity and LP ownership risks cannot be fully assessed.",
      evidence: [
        {
          type: "contract",
          chain: opts.chain,
          value: opts.token,
          label: "token",
        } satisfies EvidenceRef,
      ],
      source: "automatic",
    });
  }

  if (recentRemoves.length >= 2) {
    findings.push({
      id: `liq-removes-${opts.token}`,
      category: "liquidity",
      name: "Multiple liquidity-remove-like events",
      severity: "high",
      status: "observed",
      summary: `Detected ${recentRemoves.length} possible liquidity removal related transfers/methods.`,
      whyItMatters: "Repeated LP removals can precede or constitute exit events.",
      evidence: recentRemoves.slice(0, 5).map(
        (e): EvidenceRef => ({
          type: "tx",
          chain: opts.chain,
          value: e.txHash ?? e.id,
          label: e.title,
        })
      ),
      source: "automatic",
    });
  }

  const snapshot: LiquiditySnapshot = {
    totalUsd: null,
    pools,
    // Nothing here shows who holds the LP position. Naming the deployer would
    // be an accusation with no evidence behind it, so the field stays unknown
    // until a real LP holder read fills it in.
    dominantController: null,
    dominantPct: null,
    recentAdds: recentAdds.slice(0, 20),
    recentRemoves: recentRemoves.slice(0, 20),
    fakeOrMeaningless: false,
    notes,
  };

  return { snapshot, findings, errors };
}
