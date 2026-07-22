import type {
  EvidenceRef,
  LiquidityPool,
  LiquiditySnapshot,
  RiskFinding,
  TimelineEvent,
} from "@rugkiller/shared";
import type { BlockscoutClient } from "@rugkiller/chain";

/**
 * Liquidity analysis using explorer transfer/log heuristics.
 * When DEX pool registries are known for Arc, they should be added to network config.
 */
export async function analyzeLiquidity(opts: {
  chain: string;
  token: string;
  explorer: BlockscoutClient;
  deployer?: string | null;
}): Promise<{ snapshot: LiquiditySnapshot; findings: RiskFinding[]; errors: string[] }> {
  const findings: RiskFinding[] = [];
  const errors: string[] = [];
  const pools: LiquidityPool[] = [];
  const recentAdds: TimelineEvent[] = [];
  const recentRemoves: TimelineEvent[] = [];
  const notes: string[] = [];

  // Discover pairs via token transfers involving known pair-like contracts is hard without registry.
  // Use token page exchange data if present + transfer patterns labeled Mint/Burn if decoded.
  try {
    const token = await opts.explorer.getToken(opts.token);
    if (token?.exchange_rate) {
      notes.push(`Explorer exchange_rate=${token.exchange_rate}`);
    }
  } catch (e) {
    errors.push(`token: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    const transfers = await opts.explorer.getTokenTransfers(opts.token);
    let i = 0;
    for (const t of transfers.items ?? []) {
      const method = (t.method ?? t.type ?? "").toLowerCase();
      const tx = t.transaction_hash;
      const ts = t.timestamp ?? new Date().toISOString();
      const from = typeof t.from === "string" ? t.from : t.from?.hash;
      const to = typeof t.to === "string" ? t.to : t.to?.hash;

      if (/mint|add.?liquidity/i.test(method)) {
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
      if (/burn|remove.?liquidity/i.test(method)) {
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
  } catch (e) {
    errors.push(`transfers: ${e instanceof Error ? e.message : String(e)}`);
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
    dominantController: opts.deployer ?? null,
    dominantPct: null,
    recentAdds: recentAdds.slice(0, 20),
    recentRemoves: recentRemoves.slice(0, 20),
    fakeOrMeaningless: false,
    notes,
  };

  return { snapshot, findings, errors };
}
