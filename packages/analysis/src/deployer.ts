import type { DeployerProfile, RiskEventSummary, TimelineEvent } from "@rugkiller/shared";
import type { BlockscoutClient } from "@rugkiller/chain";

export async function buildDeployerProfile(opts: {
  chain: string;
  address: string;
  explorer: BlockscoutClient;
  currentToken?: string;
}): Promise<DeployerProfile> {
  const address = opts.address.toLowerCase();
  let firstSeenAt: string | null = null;
  let lastSeenAt: string | null = null;
  let firstFunder: string | null = null;
  const previousTokens: DeployerProfile["previousTokens"] = [];
  const timeline: TimelineEvent[] = [];
  // A transaction list we could not read to its end says nothing about when
  // this wallet started, so it must not support an age or a history label.
  let historyComplete = false;

  try {
    const txs = await opts.explorer.getAddressTransactions(address);
    const items = txs.items ?? [];
    const cursor = txs.next_page_params as Record<string, unknown> | null | undefined;
    historyComplete = !cursor || Object.keys(cursor).length === 0;
    if (items.length) {
      // API typically returns newest first
      const newest = items[0];
      const oldest = items[items.length - 1];
      lastSeenAt = newest.timestamp ?? null;
      // With a page cursor still open, the oldest row here is only the oldest
      // on this page, and a busy deployer would be reported as brand new.
      firstSeenAt = historyComplete ? oldest.timestamp ?? newest.timestamp ?? null : null;

      for (const tx of items) {
        const created = tx.created_contract?.hash;
        if (created) {
          const tokenAddr = created.toLowerCase();
          if (opts.currentToken && tokenAddr === opts.currentToken.toLowerCase()) continue;
          previousTokens.push({
            address: tokenAddr,
            name: null,
            symbol: null,
            chain: opts.chain,
            status: null,
            peakLiquidityUsd: null,
            liquidityPulled: null,
            lifetimeHours: null,
          });
          timeline.push({
            id: `deploy-${tx.hash}`,
            type: "deploy",
            // Same rule as every other chain event: an unknown time stays
            // unknown rather than being stamped with the analysis time.
            timestamp: tx.timestamp ?? null,
            chain: opts.chain,
            title: "Contract creation",
            txHash: tx.hash,
            addresses: [tokenAddr],
          });
        }
      }

      // first funder: look at oldest inbound native transfer pattern via reverse scan
      // Blockscout tx list may not include internal; approximate with first from != self
      for (let i = items.length - 1; i >= 0; i--) {
        const tx = items[i];
        const from = typeof tx.from === "string" ? tx.from : tx.from?.hash;
        const to = typeof tx.to === "string" ? tx.to : tx.to?.hash;
        if (from && to && to.toLowerCase() === address && from.toLowerCase() !== address) {
          firstFunder = from.toLowerCase();
          break;
        }
      }
    }
  } catch {
    // leave limited history
  }

  // Enrich previous tokens with names (cap 10)
  for (const t of previousTokens.slice(0, 10)) {
    try {
      const info = await opts.explorer.getToken(t.address);
      if (info) {
        t.name = info.name ?? null;
        t.symbol = info.symbol ?? null;
      }
    } catch {
      /* ignore */
    }
  }

  let ageDays: number | null = null;
  if (firstSeenAt) {
    ageDays = Math.max(
      0,
      Math.floor((Date.now() - new Date(firstSeenAt).getTime()) / (24 * 3600 * 1000))
    );
  }

  let historyLabel: DeployerProfile["historyLabel"] = "unknown";
  if (!historyComplete) {
    // Truncated history proves the wallet is at least as old as what was read,
    // so neither "limited" nor "established" is supported by it.
    historyLabel = "unknown";
  } else if (!firstSeenAt) historyLabel = "limited_history";
  else if (ageDays != null && ageDays < 7) historyLabel = "limited_history";
  else historyLabel = "established";

  const riskEvents: RiskEventSummary[] = [];

  return {
    address,
    chain: opts.chain,
    firstSeenAt,
    lastSeenAt,
    ageDays,
    historyLabel,
    firstFunder,
    tokensDeployed: previousTokens.length + (opts.currentToken ? 1 : 0),
    previousTokens,
    riskEvents,
    crossChain: [],
  };
}
