import type {
  EvidenceRef,
  HolderInfo,
  InsiderCluster,
  RiskFinding,
  ConfidenceLevel,
} from "@rugkiller/shared";
import { shouldIgnoreForOwnership } from "@rugkiller/shared";
import type { BlockscoutClient } from "@rugkiller/chain";
import { toBigInt } from "./dex.js";

export type TokenTransferPage = Awaited<ReturnType<BlockscoutClient["getTokenTransfers"]>>;

/**
 * A token transfer page already read earlier in the same analysis, carrying
 * whether the read succeeded. Passed down so one analysis does not fetch the
 * same explorer URL twice, and so a failed read stays distinguishable from an
 * empty one.
 */
export type PreloadedTransfers =
  | { ok: true; page: TokenTransferPage }
  | { ok: false; error: string };

type FunderRow = { holder: HolderInfo; funder: string; txHash?: string };

export interface HolderAnalysisResult {
  holders: HolderInfo[];
  /** Total holders seen across every fetched page, before the display cap. */
  holderCount: number | null;
  /** False when the explorer cursor was still open at the page budget. */
  holderListComplete: boolean;
  /** False when the transfer page behind the same-block bundle check failed. */
  transferHistoryComplete: boolean;
  /** False when the top-holder funding lookups did not all answer. */
  funderScanComplete: boolean;
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
  /**
   * Contracts that hold supply without owning it: the DEX pair, its router and
   * factory. A pool holding the float is exit liquidity, not concentration,
   * and counting it flagged every liquid token as highly concentrated.
   */
  poolAddresses?: (string | null | undefined)[];
  /** Transfer page already read for this token earlier in the same analysis. */
  transfers?: PreloadedTransfers;
}): Promise<HolderAnalysisResult> {
  const errors: string[] = [];
  const findings: RiskFinding[] = [];
  const holders: HolderInfo[] = [];
  const pooled = new Set(
    (opts.poolAddresses ?? []).filter(Boolean).map((a) => String(a).toLowerCase())
  );
  let dataComplete = false;
  let holderListComplete = false;
  let transferHistoryComplete = false;
  let funderScanComplete = false;

  try {
    const res = await opts.explorer.getAllTokenHolders(opts.token);
    holderListComplete = res.complete;
    // A bare BigInt() throws on anything the explorer did not format as an
    // integer, and one bad row would end the holder walk mid-list while
    // holderListComplete still said the list was whole.
    const supply = toBigInt(opts.totalSupply);
    let unreadableRows = 0;

    for (const item of res.items ?? []) {
      const address =
        typeof item.address === "string" ? item.address : item.address?.hash;
      if (!address) continue;
      const bal = item.value ?? "0";
      const balBi = toBigInt(bal);
      // An unparseable balance is an unknown holder, not a zero one. Dropping
      // it silently would shorten the holder set without recording the loss.
      if (balBi == null) {
        unreadableRows++;
        continue;
      }
      const p = supply ? pct(balBi, supply) : null;
      const labels: string[] = [];
      if (opts.deployer && address.toLowerCase() === opts.deployer.toLowerCase()) {
        labels.push("deployer");
      }
      if (shouldIgnoreForOwnership(address, opts.chain) || pooled.has(address.toLowerCase())) {
        labels.push("known_service");
      }
      if (pooled.has(address.toLowerCase())) labels.push("liquidity_pool");
      holders.push({
        address: address.toLowerCase(),
        balance: bal,
        pct: p,
        isContract: null,
        labels,
      });
    }
    if (unreadableRows > 0) {
      holderListComplete = false;
      errors.push(`holders: ${unreadableRows} holder row(s) had an unreadable balance`);
    }
    // Without total supply every share is null, so the category would report
    // zero findings and still call itself complete. That reads as "clean".
    // A truncated holder list is also incomplete: concentration computed over
    // part of the holder set understates nothing but proves nothing either.
    dataComplete = holders.length > 0 && supply != null && supply > 0n && holderListComplete;
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

  // Burn addresses, the zero address, routers and CEX wallets are not owners
  // of circulating supply. Counting them made a fully burned token read as
  // 100% concentrated, which is the opposite of the truth.
  const circulating = ranked.filter((h) => !h.labels.includes("known_service"));
  const excludedPct = ranked
    .filter((h) => h.labels.includes("known_service"))
    .reduce((a, h) => a + (h.pct ?? 0), 0);

  const top10 = circulating.slice(0, 10);
  const top10Pct =
    top10.length && top10.every((h) => h.pct != null)
      ? top10.reduce((a, h) => a + (h.pct ?? 0), 0)
      : null;

  let deployerPct: number | null = null;
  if (opts.deployer) {
    const d = holders.find((h) => h.address === opts.deployer!.toLowerCase());
    // A deployer missing from the returned page is unknown, not a zero holder.
    deployerPct = d ? d.pct : null;
  }

  if (top10Pct != null && top10Pct >= 80) {
    findings.push({
      id: `conc-top10-${opts.token}`,
      category: "holder_concentration",
      name: "High top-10 concentration",
      severity: top10Pct >= 95 ? "critical" : "high",
      status: "observed",
      summary:
        excludedPct > 0.01
          ? `Top 10 non-service holders control ~${top10Pct.toFixed(1)}% of tracked supply. A further ~${excludedPct.toFixed(1)}% sits in burn, liquidity pool or known service addresses and is excluded.`
          : `Top 10 holders control ~${top10Pct.toFixed(1)}% of tracked supply.`,
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

  // Both scans below read only `ranked`, and neither consumes the other's
  // output, so both reads are issued here instead of one full explorer hop
  // after the other.
  const transfersRead: Promise<PreloadedTransfers> = opts.transfers
    ? Promise.resolve(opts.transfers)
    : opts.explorer
        .getTokenTransfers(opts.token)
        .then((page) => ({ ok: true as const, page }))
        .catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));

  // The pair, its router and its factory hold supply without owning it and are
  // already labelled known_service above, so they never reach this heuristic.
  // The old `isContract !== true` clause read as excluding contracts but
  // isContract is never populated, so it excluded nothing.
  const candidates = ranked.filter((h) => !h.labels.includes("known_service")).slice(0, 5);
  const fundersRead: Promise<
    { ok: true; rows: (FunderRow | null)[] } | { ok: false; error: string }
  > = Promise.all(
    candidates.map(async (holder): Promise<FunderRow | null> => {
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
    })
  )
    .then((rows) => ({ ok: true as const, rows }))
    .catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));

  // Cluster heuristic: first buyers in same block from transfer history
  const clusters: InsiderCluster[] = [];
  const transfersResult = await transfersRead;
  if (transfersResult.ok) {
    transferHistoryComplete = true;
    const byBlock = new Map<number, string[]>();
    for (const t of transfersResult.page.items ?? []) {
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
  } else {
    errors.push(`transfers: ${transfersResult.error}`);
  }

  // Common-funder evidence for the largest non-service EOAs. This is stronger
  // than timing alone because every edge is backed by an explorer transaction.
  const funderResult = await fundersRead;
  if (funderResult.ok) {
    funderScanComplete = true;
    const groups = new Map<string, FunderRow[]>();
    for (const row of funderResult.rows) {
      if (!row) continue;
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
  } else {
    errors.push(`common funders: ${funderResult.error}`);
  }

  // A scan that never ran leaves the insider category empty, and an empty
  // category reads as examined and clean. Both gaps are recorded so the
  // category is reported as incomplete rather than as no signals.
  if (!transferHistoryComplete) {
    findings.push({
      id: `transfer-history-gap-${opts.token}`,
      category: "data_gaps",
      name: "Token transfer history could not be read",
      severity: "medium",
      status: "observed",
      summary: "The explorer did not return this token's transfer list, so same-block bundle patterns were not examined.",
      whyItMatters:
        "An unread transfer history is unknown, not clean. Coordinated launch buys would not be visible here.",
      evidence: [
        { type: "contract", chain: opts.chain, value: opts.token, label: "Token whose transfer list failed to load" },
      ],
      source: "automatic",
    });
  }

  if (!funderScanComplete) {
    findings.push({
      id: `funder-scan-gap-${opts.token}`,
      category: "data_gaps",
      name: "Top-holder funding history could not be read",
      severity: "medium",
      status: "observed",
      summary: "Transaction lists for the largest holders did not load, so shared-funder links were not examined.",
      whyItMatters:
        "An unread funding history is unknown, not clean. Wallets funded from one source would not be visible here.",
      evidence: [
        { type: "contract", chain: opts.chain, value: opts.token, label: "Token whose holder funding scan failed" },
      ],
      source: "automatic",
    });
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
      evidence: [
        { type: "contract", chain: opts.chain, value: opts.token, label: "Token whose holder list failed to load" },
      ],
      source: "automatic",
    });
  }

  return {
    // Keep a generous slice for display; the true count is reported separately
    // so nothing downstream mistakes the cap for the real holder total.
    holders: ranked.slice(0, 200),
    holderCount: holders.length ? holders.length : null,
    holderListComplete,
    transferHistoryComplete,
    funderScanComplete,
    top10Pct,
    deployerPct,
    clusters,
    findings,
    dataComplete,
    errors,
  };
}
