import type {
  EvidenceRef,
  HolderInfo,
  InsiderCluster,
  RiskFinding,
  ConfidenceLevel,
} from "@rugkiller/shared";
import { shouldIgnoreForOwnership } from "@rugkiller/shared";
import type { BlockscoutClient } from "@rugkiller/chain";

export interface HolderAnalysisResult {
  holders: HolderInfo[];
  top10Pct: number | null;
  deployerPct: number | null;
  clusters: InsiderCluster[];
  findings: RiskFinding[];
  dataComplete: boolean;
  errors: string[];
}

function pct(balance: bigint, supply: bigint): number | null {
  if (supply <= 0n) return null;
  // Preserve six decimal places so small, real holders do not collapse to 0%.
  return Number((balance * 100_000_000n) / supply) / 1_000_000;
}

export async function analyzeHolders(opts: {
  chain: string;
  token: string;
  explorer: BlockscoutClient;
  deployer?: string | null;
  totalSupply?: string | null;
}): Promise<HolderAnalysisResult> {
  const errors: string[] = [];
  const findings: RiskFinding[] = [];
  const holders: HolderInfo[] = [];
  let dataComplete = false;

  try {
    const res = await opts.explorer.getTokenHolders(opts.token);
    const supply = opts.totalSupply ? BigInt(opts.totalSupply) : null;

    for (const item of res.items ?? []) {
      const address =
        typeof item.address === "string" ? item.address : item.address?.hash;
      if (!address) continue;
      const bal = item.value ?? "0";
      const balBi = BigInt(bal);
      const p = supply ? pct(balBi, supply) : null;
      const labels: string[] = [];
      if (opts.deployer && address.toLowerCase() === opts.deployer.toLowerCase()) {
        labels.push("deployer");
      }
      if (shouldIgnoreForOwnership(address, opts.chain)) {
        labels.push("known_service");
      }
      holders.push({
        address: address.toLowerCase(),
        balance: bal,
        pct: p,
        isContract: null,
        labels,
      });
    }
    dataComplete = holders.length > 0;
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  const ranked = [...holders].sort((a, b) => {
    try {
      return BigInt(b.balance) > BigInt(a.balance) ? 1 : -1;
    } catch {
      return 0;
    }
  });

  const top10 = ranked.slice(0, 10);
  const top10Pct =
    top10.length && top10.every((h) => h.pct != null)
      ? top10.reduce((a, h) => a + (h.pct ?? 0), 0)
      : null;

  let deployerPct: number | null = null;
  if (opts.deployer) {
    const d = holders.find((h) => h.address === opts.deployer!.toLowerCase());
    deployerPct = d?.pct ?? 0;
  }

  if (top10Pct != null && top10Pct >= 80) {
    findings.push({
      id: `conc-top10-${opts.token}`,
      category: "holder_concentration",
      name: "High top-10 concentration",
      severity: top10Pct >= 95 ? "critical" : "high",
      status: "observed",
      summary: `Top 10 holders control ~${top10Pct.toFixed(1)}% of tracked supply.`,
      whyItMatters: "Concentrated supply enables sudden dumps.",
      evidence: top10.slice(0, 5).map(
        (h): EvidenceRef => ({
          type: "address",
          chain: opts.chain,
          value: h.address,
          label: h.pct != null ? `${h.pct.toFixed(2)}%` : undefined,
        })
      ),
      source: "automatic",
    });
  }

  if (deployerPct != null && deployerPct >= 20) {
    findings.push({
      id: `dep-hold-${opts.token}`,
      category: "insider_links",
      name: "Deployer holds large supply share",
      severity: deployerPct >= 50 ? "critical" : "high",
      status: "observed",
      summary: `Deployer holds ~${deployerPct.toFixed(1)}% of supply.`,
      whyItMatters: "Deployer can materially impact price by selling.",
      controllerAddress: opts.deployer ?? undefined,
      evidence: [
        {
          type: "address",
          chain: opts.chain,
          value: opts.deployer!,
          label: "deployer",
        },
      ],
      source: "automatic",
    });
  }

  // Cluster heuristic: first buyers in same block from transfer history
  const clusters: InsiderCluster[] = [];
  try {
    const transfers = await opts.explorer.getTokenTransfers(opts.token);
    const byBlock = new Map<number, string[]>();
    for (const t of transfers.items ?? []) {
      const to =
        typeof t.to === "string" ? t.to : t.to?.hash;
      const bn = t.block_number;
      if (!to || bn == null) continue;
      if (shouldIgnoreForOwnership(to, opts.chain)) continue;
      const arr = byBlock.get(bn) ?? [];
      arr.push(to.toLowerCase());
      byBlock.set(bn, arr);
    }
    for (const [block, addrs] of byBlock) {
      const unique = [...new Set(addrs)];
      if (unique.length >= 3) {
        const conf: ConfidenceLevel = unique.length >= 5 ? "medium" : "low";
        const cluster: InsiderCluster = {
          id: `block-bundle-${block}`,
          addresses: unique,
          totalPct: null,
          reason: `${unique.length} distinct recipients received tokens in the same block ${block} (possible bundle/sniper pattern).`,
          confidence: conf,
          evidence: [
            {
              type: "block",
              chain: opts.chain,
              value: String(block),
              label: "same-block recipients",
            },
            ...unique.slice(0, 8).map(
              (a): EvidenceRef => ({ type: "address", chain: opts.chain, value: a })
            ),
          ],
        };
        clusters.push(cluster);
        findings.push({
          id: cluster.id,
          category: "insider_links",
          name: "Same-block multi-recipient acquisition",
          severity: "medium",
          status: "observed",
          summary: cluster.reason,
        whyItMatters: "May indicate coordinated sniping or bundled insider buys. This alone is not proof of malice.",
          evidence: cluster.evidence,
          source: "automatic",
        });
        break; // prioritize one strongest pattern for default report
      }
    }
  } catch (e) {
    errors.push(`transfers: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Common-funder evidence for the largest non-service EOAs. This is stronger
  // than timing alone because every edge is backed by an explorer transaction.
  try {
    const candidates = ranked.filter((h) => !h.labels.includes("known_service") && h.isContract !== true).slice(0, 5);
    const funded = await Promise.all(candidates.map(async (holder) => {
      const txs = await opts.explorer.getAddressTransactions(holder.address);
      const inbound = [...(txs.items ?? [])].reverse().find((tx) => {
        const from = typeof tx.from === "string" ? tx.from : tx.from?.hash;
        const to = typeof tx.to === "string" ? tx.to : tx.to?.hash;
        return from && to?.toLowerCase() === holder.address && from.toLowerCase() !== holder.address;
      });
      const from = inbound ? (typeof inbound.from === "string" ? inbound.from : inbound.from?.hash) : null;
      return from && !shouldIgnoreForOwnership(from, opts.chain)
        ? { holder, funder: from.toLowerCase(), txHash: inbound?.hash }
        : null;
    }));
    const groups = new Map<string, NonNullable<(typeof funded)[number]>[]>();
    for (const row of funded.filter(Boolean) as NonNullable<(typeof funded)[number]>[]) {
      groups.set(row.funder, [...(groups.get(row.funder) ?? []), row]);
    }
    for (const [funder, rows] of groups) {
      if (rows.length < 2) continue;
      const totalPct = rows.every((r) => r.holder.pct != null)
        ? rows.reduce((sum, r) => sum + (r.holder.pct ?? 0), 0)
        : null;
      const cluster: InsiderCluster = {
        id: `common-funder-${funder}-${opts.token}`,
        addresses: rows.map((r) => r.holder.address),
        totalPct,
        reason: `${rows.length} top holders share the same earliest observed funder ${funder}.`,
        confidence: "high",
        evidence: rows.flatMap((r) => [
          { type: "tx" as const, chain: opts.chain, value: r.txHash ?? "", label: "funding transaction" },
          { type: "address" as const, chain: opts.chain, value: funder, label: "common funder" },
        ]).filter((e) => e.value),
      };
      clusters.push(cluster);
      findings.push({
        id: cluster.id,
        category: "insider_links",
        name: "Top holders share a common funder",
        severity: (totalPct ?? 0) >= 30 ? "high" : "medium",
        status: "observed",
        summary: cluster.reason,
        whyItMatters: "Shared funding can indicate coordinated ownership even when balances are split across wallets.",
        controllerAddress: funder,
        evidence: cluster.evidence,
        source: "automatic",
      });
    }
  } catch (e) {
    errors.push(`common funders: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!dataComplete) {
    findings.push({
      id: `holder-gap-${opts.token}`,
      category: "data_gaps",
      name: "Holder data incomplete",
      severity: "medium",
      status: "observed",
      summary: "Could not load a reliable holder set from explorer.",
      whyItMatters: "Concentration risk may be understated.",
      evidence: [],
      source: "automatic",
    });
  }

  return {
    holders: ranked.slice(0, 50),
    top10Pct,
    deployerPct,
    clusters,
    findings,
    dataComplete,
    errors,
  };
}
