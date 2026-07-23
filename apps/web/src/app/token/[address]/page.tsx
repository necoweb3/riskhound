import Link from "next/link";
import {
  apiGet,
  getApiUrl,
  categoryLabel,
  friendlySignal,
  shortAddr,
  severityClass,
  severityLabel,
  timeAgo,
  tokenDisplayName,
  formatLiquidity,
} from "@/lib/api";
import { RiskBadge } from "@/components/RiskBadge";
import { AnalyzeButton } from "./AnalyzeButton";
import { CopyAddress } from "@/components/CopyAddress";
import { HolderBubbleMap } from "@/components/HolderBubbleMap";

export const dynamic = "force-dynamic";

type Finding = {
  id?: string;
  category?: string;
  name: string;
  severity: string;
  summary: string;
  whyItMatters?: string;
  status?: string;
  relatedFunction?: string;
  evidenceJson?: { type: string; value: string; label?: string; url?: string }[];
  evidence?: { type: string; value: string; label?: string; url?: string }[];
};

type TokenPayload = {
  summary: {
    name?: string | null;
    symbol?: string | null;
    address?: string;
    deployer?: string | null;
    owner?: string | null;
    isProxy?: boolean;
    isVerified?: boolean;
    hasRobinhoodLink?: boolean;
    holderCount?: number | null;
    liquidityUsd?: number | null;
    overallRisk?: string | null;
    topSignals?: string[];
  };
  report: {
    overall: string;
    confidence: string;
    categories: {
      category: string;
      score: number;
      label: string;
      explanation: string;
      findings: Finding[];
    }[];
    topFindings: Finding[];
    analyzedAt: string;
  } | null;
  findings: Finding[];
  holders: { address: string; balance: string; pct: number | null; labels: string[] }[];
  simulation: {
    canBuy: boolean | null;
    canSell: boolean | null;
    summary: string;
    steps?: { step: string; success: boolean; detail: string }[];
  } | null;
  stale?: boolean;
  analysisUpdatedAt?: string;
  analysisPending?: boolean;
  explorerAddress?: string;
  deployerProfile?: {
    historyLabel?: string;
    ageDays?: number | null;
  } | null;
  crossLinks?: { strength: string; reason: string }[];
};

async function loadToken(addr: string): Promise<{ data?: TokenPayload; err?: string }> {
  try {
    const cached = await apiGet<{
      summary: TokenPayload["summary"] & { address: string };
      report: TokenPayload["report"];
      findings: Finding[];
      holders: TokenPayload["holders"];
      simulation: TokenPayload["simulation"];
      stale?: boolean;
      analysisUpdatedAt?: string;
      analysisPending?: boolean;
    }>(`/tokens/${addr}`);

    // Refresh stale analyses in background-style (await for correctness)
    if (cached.stale) {
      try {
        const res = await fetch(`${getApiUrl()}/tokens/${addr}/analyze`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ force: true }),
          cache: "no-store",
        });
        if (res.ok) {
          const live = await res.json();
          return {
            data: {
              summary: {
                ...live.detail,
                address: live.detail?.address ?? addr,
              },
              report: live.report ?? null,
              findings: live.detail?.contractFindings ?? live.report?.topFindings ?? [],
              holders: live.detail?.holders ?? [],
              simulation: live.detail?.simulation ?? null,
              stale: false,
              analysisUpdatedAt: live.report?.analyzedAt,
              explorerAddress: live.detail?.explorerUrls?.address,
              deployerProfile: live.detail?.deployerProfile ?? null,
              crossLinks: live.detail?.crossChainLinks ?? [],
            },
          };
        }
      } catch {
        /* keep cache */
      }
    }

    return {
      data: {
        summary: cached.summary,
        report: cached.report,
        findings: cached.findings ?? [],
        holders: cached.holders ?? [],
        simulation: cached.simulation,
        stale: cached.stale,
        analysisUpdatedAt: cached.analysisUpdatedAt,
        analysisPending: cached.analysisPending,
        explorerAddress: `https://testnet.arcscan.app/address/${addr}`,
      },
    };
  } catch {
    // Not in cache. Run live analysis.
    try {
      const res = await fetch(`${getApiUrl()}/tokens/${addr}/analyze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
        cache: "no-store",
      });
      const live = await res.json();
      if (!res.ok) {
        const msg =
          typeof live?.message === "string"
            ? live.message
            : typeof live?.error === "string"
              ? live.error
              : "Check failed";
        return { err: msg };
      }
      return {
        data: {
          summary: {
            ...live.detail,
            address: live.detail?.address ?? addr,
          },
          report: live.report ?? null,
          findings: live.detail?.contractFindings ?? live.report?.topFindings ?? [],
          holders: live.detail?.holders ?? [],
          simulation: live.detail?.simulation ?? null,
          stale: false,
          analysisUpdatedAt: live.report?.analyzedAt,
          explorerAddress: live.detail?.explorerUrls?.address,
          deployerProfile: live.detail?.deployerProfile ?? null,
          crossLinks: live.detail?.crossChainLinks ?? [],
        },
      };
    } catch (e) {
      return {
        err: e instanceof Error ? e.message : "Could not load token",
      };
    }
  }
}

export default async function TokenPage({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  const { address } = await params;
  const addr = address.toLowerCase();

  if (!/^0x[a-f0-9]{40}$/.test(addr)) {
    return (
      <div className="rk-stack-lg" style={{ maxWidth: 480, margin: "0 auto", textAlign: "center" }}>
        <h1 className="rk-h1" style={{ fontSize: "1.75rem" }}>
          Invalid address
        </h1>
        <p className="rk-faint">Use a 0x address with 40 hex characters.</p>
        <Link href="/scan" className="rk-btn rk-btn--primary">
          Check a token
        </Link>
      </div>
    );
  }

  const { data, err } = await loadToken(addr);

  if (err || !data) {
    return (
      <div className="rk-stack-lg" style={{ maxWidth: 520, margin: "0 auto", textAlign: "center" }}>
        <h1 className="rk-h1" style={{ fontSize: "1.75rem" }}>
          Could not check this token
        </h1>
        <div className="rk-alert">{err ?? "Unknown error"}</div>
        <div className="rk-row" style={{ justifyContent: "center" }}>
          <AnalyzeButton address={addr} />
          <Link href="/feed" className="rk-btn rk-btn--sm">
            Back to Discover
          </Link>
        </div>
      </div>
    );
  }

  const { summary, report, simulation, holders, findings, deployerProfile } = data;
  const displayName = tokenDisplayName({
    name: summary.name,
    symbol: summary.symbol,
    address: summary.address ?? addr,
  });
  const updated = timeAgo(data.analysisUpdatedAt ?? report?.analyzedAt);
  const liq = formatLiquidity(summary.liquidityUsd ?? null);

  const steps = Array.isArray(simulation?.steps) ? simulation!.steps! : [];

  const sellLabel =
    simulation?.canSell === false
      ? "Problem"
      : simulation?.canSell === true
        ? "Looks open"
        : "Unclear";
  const buyLabel =
    simulation?.canBuy === true
      ? "Looks open"
      : simulation?.canBuy === false
        ? "Failed"
        : "Unclear";

  const sellStory =
    simulation?.canSell === false && simulation?.canBuy === true
      ? "Buying may work, but selling looks blocked or restricted."
      : simulation?.canSell === true
        ? "A sell check completed without an obvious block."
        : "We could not fully confirm whether normal users can sell.";

  const top3 = holders
    .filter((h) => h.pct != null)
    .slice(0, 3)
    .reduce((a, h) => a + (h.pct ?? 0), 0);

  const topFindings = (report?.topFindings?.length ? report.topFindings : findings).slice(0, 8);
  const creatorHistoryWarnings = (report?.topFindings ?? findings).filter(
    (finding) => finding.category === "cross_chain"
  );

  return (
    <div className="rk-stack-lg">
      <header className="rk-token-hero">
        <div style={{ minWidth: 0, flex: 1 }}>
          <h1 className="rk-h1" style={{ fontSize: "clamp(1.65rem, 3.5vw, 2.35rem)" }}>
            {displayName}
            {summary.symbol && summary.name ? (
              <span className="rk-faint" style={{ fontWeight: 500, fontSize: "0.62em" }}>
                {" · "}{summary.symbol}
              </span>
            ) : null}
          </h1>
          <div className="rk-row mt-1">
            <CopyAddress address={summary.address ?? addr} />
          </div>
          <div className="rk-row mt-1">
            {report && <RiskBadge risk={report.overall} />}
            {!summary.isVerified && <span className="rk-chip">Code not verified</span>}
            {summary.isProxy && <span className="rk-chip">Upgradeable</span>}
            {data.stale && <span className="rk-chip">Refreshing…</span>}
            {data.analysisPending && <span className="rk-chip">Analysis queued</span>}
          </div>
          {updated && (
            <p className="rk-faint" style={{ margin: "0.65rem 0 0", fontSize: "0.8rem" }}>
              Updated {updated}
            </p>
          )}
        </div>
        <div className="rk-row">
          <AnalyzeButton address={addr} />
          {data.explorerAddress && (
            <a
              className="rk-btn rk-btn--sm"
              href={data.explorerAddress}
              target="_blank"
              rel="noreferrer"
            >
              Explorer
            </a>
          )}
        </div>
      </header>

      <section className="rk-stat-row">
        <div className="rk-stat">
          <span className="rk-stat__label">Overall</span>
          <div className="rk-stat__value">
            {report ? <RiskBadge risk={report.overall} /> : data.analysisPending ? "Queued" : "Not checked"}
          </div>
        </div>
        <div className="rk-stat">
          <span className="rk-stat__label">Sell</span>
          <div className="rk-stat__value">{sellLabel}</div>
        </div>
        <div className="rk-stat">
          <span className="rk-stat__label">Buy</span>
          <div className="rk-stat__value">{buyLabel}</div>
        </div>
        <div className="rk-stat">
          <span className="rk-stat__label">Top 3 hold</span>
          <div className="rk-stat__value">{top3 > 0 ? `${top3.toFixed(0)}%` : "n/a"}</div>
        </div>
      </section>

      {report && (
        <section className="rk-card">
          <h2 className="rk-h2">Risk breakdown</h2>
          <div className="rk-grid-2 mt-1">
            {report.categories
              .filter((c) => c.category !== "data_gaps" || c.score > 0)
              .filter(
                (c) =>
                  c.score > 0 ||
                  [
                    "contract",
                    "buy_sell",
                    "liquidity",
                    "deployer_history",
                    "holder_concentration",
                  ].includes(c.category)
              )
              .slice(0, 6)
              .map((c) => {
                const tone =
                  c.score >= 70 ? "is-critical" : c.score >= 40 ? "is-high" : c.score > 0 ? "" : "is-ok";
                const level =
                  c.score >= 70 ? "High" : c.score >= 40 ? "Medium" : c.score > 0 ? "Low" : "Clear";
                return (
                  <div key={c.category} className="rk-score">
                    <div className="rk-score__top">
                      <span>{categoryLabel(c.category)}</span>
                      <span className="rk-faint">{level}</span>
                    </div>
                    <div className={`rk-score__bar ${tone}`}>
                      <i style={{ width: `${Math.min(100, Math.max(c.score, 6))}%` }} />
                    </div>
                    <div className="rk-score__hint">
                      {c.score === 0 ? "Nothing flagged" : friendlySignal(c.explanation)}
                    </div>
                  </div>
                );
              })}
          </div>
          <p className="rk-faint mt-2" style={{ fontSize: "0.8rem", marginBottom: 0 }}>
            Clear does not mean safe. It only means we did not find a flag in that area.
          </p>
        </section>
      )}

      <div className="rk-grid-2">
        <section className="rk-card">
          <h2 className="rk-h2">What we found</h2>
          <div className="rk-stack">
            {topFindings.map((f, i) => {
              const proof = Array.isArray(f.evidence)
                ? f.evidence
                : Array.isArray(f.evidenceJson)
                  ? f.evidenceJson
                  : [];
              return (
                <article key={f.id ?? i} className={`rk-finding rk-finding--${f.severity || "info"}`}>
                  <div className="rk-between">
                    <strong style={{ fontSize: "0.92rem" }}>{friendlySignal(f.name)}</strong>
                    <span className={severityClass(f.severity)}>{severityLabel(f.severity)}</span>
                  </div>
                  <p>{friendlySignal(f.summary)}</p>
                  {f.whyItMatters && (
                    <p className="rk-faint" style={{ fontSize: "0.85rem" }}>
                      Why it matters: {f.whyItMatters}
                    </p>
                  )}
                  {proof.length > 0 && (
                    <details className="rk-proof">
                      <summary>Show proof</summary>
                      <ul>
                        {proof.slice(0, 4).map((e, j) => (
                          <li key={j}>
                            {e.url ? (
                              <a href={e.url} target="_blank" rel="noreferrer">
                                {e.label ?? "Open reference"}
                              </a>
                            ) : (
                              <span className="rk-mono">{shortAddr(e.value) || e.type}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </article>
              );
            })}
            {!topFindings.length && (
              <p className="rk-faint">
                {data.analysisPending ? "Risk analysis is queued. Refresh shortly to see the evidence." : "No specific flags stored yet."}
              </p>
            )}
          </div>
        </section>

        <div className="rk-stack">
          <section className="rk-card">
            <h2 className="rk-h2">Buy and sell</h2>
            <p style={{ margin: "0 0 0.75rem", color: "var(--text-2)" }}>{sellStory}</p>
            <div className="rk-row">
              <span className="rk-chip">Buy: {buyLabel}</span>
              <span className="rk-chip">Sell: {sellLabel}</span>
            </div>
            {steps.length > 0 && (
              <details className="rk-proof">
                <summary>Show check steps</summary>
                <ul>
                  {steps.map((s, i) => (
                    <li key={i}>
                      {s.success ? "OK" : "Issue"}: {s.step}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>

          <section className="rk-card">
            <h2 className="rk-h2">Creator</h2>
            {creatorHistoryWarnings.length > 0 && (
              <div className="rk-alert" role="alert" style={{ marginBottom: "1rem" }}>
                <strong>Warning: concerning creator history found</strong>
                {creatorHistoryWarnings.slice(0, 3).map((warning, index) => {
                  const proof = warning.evidence ?? warning.evidenceJson ?? [];
                  const source = proof.find((item) => item.url);
                  return (
                    <div key={warning.id ?? index} style={{ marginTop: "0.65rem" }}>
                      <p style={{ margin: 0 }}>{friendlySignal(warning.summary)}</p>
                      {source?.url && (
                        <a
                          href={source.url}
                          target="_blank"
                          rel="noreferrer"
                          className="rk-address-link rk-address-link--inline"
                        >
                          Review evidence <span aria-hidden="true">→</span>
                        </a>
                      )}
                    </div>
                  );
                })}
                <p className="rk-faint" style={{ margin: "0.65rem 0 0", fontSize: "0.8rem" }}>
                  This supports the Arc analysis. Activity on another network is not risky by itself.
                </p>
              </div>
            )}
            {summary.deployer ? (
              <>
                <p style={{ margin: 0 }}>
                  <Link href={`/wallet/${summary.deployer}`} className="rk-address-link">
                    <span className="rk-mono">{shortAddr(summary.deployer)}</span>
                    <span aria-hidden="true">View wallet →</span>
                  </Link>
                </p>
                {deployerProfile?.historyLabel === "limited_history" && (
                  <p className="rk-faint mt-1" style={{ marginBottom: 0 }}>
                    Limited history. Not automatically bad, but little track record.
                  </p>
                )}
                {deployerProfile?.historyLabel === "established" && (
                  <p className="rk-faint mt-1" style={{ marginBottom: 0 }}>
                    Active for a while
                    {deployerProfile.ageDays != null
                      ? ` (about ${deployerProfile.ageDays} days)`
                      : ""}
                    .
                  </p>
                )}
              </>
            ) : (
              <p className="rk-faint" style={{ margin: 0 }}>
                Creator not identified yet.
              </p>
            )}
            {summary.owner && (
              <p className="rk-faint mt-1" style={{ marginBottom: 0, fontSize: "0.85rem" }}>
                Owner:{" "}<Link href={`/wallet/${summary.owner}`} className="rk-address-link rk-address-link--inline"><span className="rk-mono">{shortAddr(summary.owner)}</span><span aria-hidden="true">→</span></Link>
              </p>
            )}
            {liq && (
              <p className="rk-faint mt-1" style={{ marginBottom: 0, fontSize: "0.85rem" }}>
                Liquidity (if known): {liq}
              </p>
            )}
          </section>
        </div>
      </div>

      <section className="rk-card">
        <div className="rk-section-head">
          <div>
            <h2 className="rk-h2 mb-0">Holder map</h2>
            <p className="rk-faint" style={{ margin: "0.35rem 0 0", fontSize: "0.85rem" }}>
              Bubble size is share of supply. Click a bubble to open the wallet.
            </p>
          </div>
          {summary.holderCount != null && (
            <span className="rk-chip">{summary.holderCount} holders tracked</span>
          )}
        </div>
        <HolderBubbleMap holders={holders} />
      </section>

      <section className="rk-card">
        <h2 className="rk-h2">Top holders</h2>
        {holders.length === 0 ? (
          <p className="rk-faint" style={{ margin: 0 }}>
            Holder list not available yet for this token.
          </p>
        ) : (
          <table className="rk-table">
            <thead>
              <tr>
                <th>Wallet</th>
                <th>Share</th>
                <th>Balance</th>
              </tr>
            </thead>
            <tbody>
              {holders.slice(0, 15).map((h) => (
                <tr key={h.address}>
                  <td>
                    <Link href={`/wallet/${h.address}`} className="rk-address-link rk-address-link--inline">
                      <span className="rk-mono">{shortAddr(h.address)}</span><span aria-hidden="true">→</span>
                    </Link>
                    {h.labels?.includes("deployer") && (
                      <span className="rk-chip" style={{ marginLeft: 8 }}>
                        Creator
                      </span>
                    )}
                  </td>
                  <td>{h.pct != null ? `${h.pct.toFixed(2)}%` : "n/a"}</td>
                  <td className="rk-mono rk-faint" style={{ fontSize: "0.8rem" }}>
                    {h.balance.length > 16 ? `${h.balance.slice(0, 10)}…` : h.balance}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

    </div>
  );
}
