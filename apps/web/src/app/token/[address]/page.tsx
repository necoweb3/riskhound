import Link from "next/link";
import {
  apiGet,
  getApiUrl,
  categoryLabel,
  friendlySignal,
  shortAddr,
  severityLabel,
  timeAgo,
  tokenDisplayName,
  formatLiquidity,
  riskLabel,
} from "@/lib/api";
import { RiskBadge } from "@/components/RiskBadge";
import { AnalyzeButton } from "./AnalyzeButton";
import { CopyAddress } from "@/components/CopyAddress";
import { Reveal } from "@/components/Reveal";

export const dynamic = "force-dynamic";

type Evidence = { type: string; value: string; label?: string; url?: string };

type Finding = {
  id?: string;
  category?: string;
  name: string;
  severity: string;
  summary: string;
  whyItMatters?: string;
  status?: string;
  relatedFunction?: string;
  evidenceJson?: Evidence[];
  evidence?: Evidence[];
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
    categories: { category: string; score: number; label: string; explanation: string; findings: Finding[] }[];
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
  deployerProfile?: { historyLabel?: string; ageDays?: number | null } | null;
  crossLinks?: { strength: string; reason: string }[];
};

const DIAL_PATH = "M27.8 104.2 A54 54 0 1 1 104.2 104.2";
const ARC_LEN = 254.5;

function toneFor(score: number) {
  if (score >= 70) return "var(--red)";
  if (score >= 40) return "var(--amber)";
  if (score > 0) return "var(--yellow)";
  return "var(--green)";
}

function riskTone(overall: string | null | undefined) {
  switch (overall) {
    case "critical_risk": return "var(--red)";
    case "high_risk": return "var(--amber)";
    case "caution": return "var(--yellow)";
    case "low_detected_risk": return "var(--green)";
    default: return "var(--text-3)";
  }
}

async function loadToken(addr: string): Promise<{ data?: TokenPayload; err?: string }> {
  const fromLive = (live: Record<string, unknown> & { detail?: Record<string, unknown>; report?: unknown }) => ({
    summary: { ...(live.detail as object), address: (live.detail as { address?: string })?.address ?? addr },
    report: (live.report as TokenPayload["report"]) ?? null,
    findings:
      ((live.detail as { contractFindings?: Finding[] })?.contractFindings) ??
      ((live.report as { topFindings?: Finding[] })?.topFindings) ??
      [],
    holders: ((live.detail as { holders?: TokenPayload["holders"] })?.holders) ?? [],
    simulation: ((live.detail as { simulation?: TokenPayload["simulation"] })?.simulation) ?? null,
    stale: false,
    analysisUpdatedAt: (live.report as { analyzedAt?: string })?.analyzedAt,
    explorerAddress: (live.detail as { explorerUrls?: { address?: string } })?.explorerUrls?.address,
    deployerProfile: ((live.detail as { deployerProfile?: TokenPayload["deployerProfile"] })?.deployerProfile) ?? null,
    crossLinks: ((live.detail as { crossChainLinks?: TokenPayload["crossLinks"] })?.crossChainLinks) ?? [],
  }) as TokenPayload;

  try {
    const cached = await apiGet<TokenPayload & { summary: TokenPayload["summary"] & { address: string } }>(`/tokens/${addr}`);

    // A stale cache must not make every visitor wait on a full re-analysis, so
    // the refresh is queued and the stored report is rendered straight away.
    let queued = false;
    if (cached.stale) {
      try {
        const res = await fetch(`${getApiUrl()}/tokens/${addr}/analyze`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ async: true, force: true }),
          cache: "no-store",
          signal: AbortSignal.timeout(4000),
        });
        queued = res.ok && ((await res.json()) as { queued?: boolean }).queued === true;
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
        analysisPending: cached.analysisPending || queued,
        explorerAddress: `https://testnet.arcscan.app/address/${addr}`,
      },
    };
  } catch {
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
          typeof live?.message === "string" ? live.message : typeof live?.error === "string" ? live.error : "Check failed";
        return { err: msg };
      }
      return { data: fromLive(live) };
    } catch (e) {
      return { err: e instanceof Error ? e.message : "Could not load token" };
    }
  }
}

export default async function TokenPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const addr = address.toLowerCase();

  if (!/^0x[a-f0-9]{40}$/.test(addr)) {
    return (
      <div className="rk-stack-lg" style={{ maxWidth: 480, margin: "0 auto", textAlign: "center" }}>
        <h1 className="rk-h1" style={{ fontSize: 28 }}>Invalid address</h1>
        <p className="rk-faint">Use a 0x address with 40 hex characters.</p>
        <Link href="/scan" className="rk-btn rk-btn--primary">Check a token</Link>
      </div>
    );
  }

  const { data, err } = await loadToken(addr);

  if (err || !data) {
    return (
      <div className="rk-stack-lg" style={{ maxWidth: 520, margin: "0 auto", textAlign: "center" }}>
        <h1 className="rk-h1" style={{ fontSize: 28 }}>Could not check this token</h1>
        <div className="rk-alert">{err ?? "Unknown error"}</div>
        <div className="rk-row" style={{ justifyContent: "center" }}>
          <AnalyzeButton address={addr} />
          <Link href="/feed" className="rk-btn rk-btn--sm">Back to Discover</Link>
        </div>
      </div>
    );
  }

  const { summary, report, simulation, holders, findings, deployerProfile } = data;
  const displayName = tokenDisplayName({ name: summary.name, symbol: summary.symbol, address: summary.address ?? addr });
  const updated = timeAgo(data.analysisUpdatedAt ?? report?.analyzedAt);
  const liq = formatLiquidity(summary.liquidityUsd ?? null);
  const steps = Array.isArray(simulation?.steps) ? simulation!.steps! : [];

  // Every category is listed, otherwise a fixed order silently hides the last
  // ones. An empty data_gaps row says nothing, so it is the only one dropped.
  const categories = (report?.categories ?? []).filter((c) => c.category !== "data_gaps" || c.score > 0);

  // Headline number is the worst category score, never an invented average.
  // data_gaps is what is missing rather than something observed, so it is left
  // out here exactly as aggregateOverall leaves it out of the overall level.
  // With the gaps excluded an unreadable token scores 0, so a report that
  // already declares the data insufficient stays unscored instead of showing a
  // number that reads as safety.
  const scored = (report?.categories ?? []).filter((c) => c.category !== "data_gaps");
  const score =
    scored.length && report?.overall !== "insufficient_data"
      ? Math.max(...scored.map((c) => c.score))
      : null;
  const tone = riskTone(report?.overall);
  const offset =
    score == null ? ARC_LEN : Math.round(ARC_LEN * (1 - Math.min(100, Math.max(0, score)) / 100) * 10) / 10;

  const sellLabel = simulation?.canSell === false ? "Reverted" : simulation?.canSell === true ? "Open" : "Unclear";
  const buyLabel = simulation?.canBuy === true ? "Open" : simulation?.canBuy === false ? "Failed" : "Unclear";
  const sellTone = simulation?.canSell === false ? "var(--red)" : simulation?.canSell === true ? "var(--green)" : "var(--text-3)";
  const buyTone = simulation?.canBuy === false ? "var(--red)" : simulation?.canBuy === true ? "var(--green)" : "var(--text-3)";

  const sellStory =
    simulation?.canSell === false && simulation?.canBuy === true
      ? "Buying may work, but selling looks blocked or restricted for a normal holder."
      : simulation?.canSell === true
        ? "A sell check completed without an obvious block."
        : "We could not fully confirm whether normal users can sell.";

  const ranked = holders.filter((h) => h.pct != null);
  const top3 = ranked.slice(0, 3).reduce((a, h) => a + (h.pct ?? 0), 0);
  const top10 = ranked.slice(0, 10).reduce((a, h) => a + (h.pct ?? 0), 0);
  const tracked = ranked.slice(0, 12);
  const rest = Math.max(0, 100 - tracked.reduce((a, h) => a + (h.pct ?? 0), 0));

  // topFindings is already capped by the API, so the count has to come from the
  // category breakdown or the page under-reports what was actually found.
  const findingSource = report?.topFindings?.length ? report.topFindings : findings;
  const findingCount = report?.categories?.length
    ? report.categories.reduce((n, c) => n + (c.findings ?? []).length, 0)
    : findingSource.length;
  const topFindings = findingSource.slice(0, 10);
  const creatorWarnings = (report?.topFindings ?? findings).filter((f) => f.category === "cross_chain");

  return (
    <div className="rk-stack-lg">
      <nav aria-label="Breadcrumb" style={{ display: "flex", gap: 7, fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.05em", color: "var(--text-3)", textTransform: "uppercase" }}>
        <Link href="/feed" style={{ color: "var(--text-3)" }}>Discover</Link>
        <span style={{ color: "var(--line-2)" }}>/</span>
        <span style={{ color: "var(--text-2)" }}>Arc Testnet</span>
        <span style={{ color: "var(--line-2)" }}>/</span>
        <span style={{ color: "var(--text-2)" }}>{shortAddr(summary.address ?? addr)}</span>
      </nav>

      <header className="rk-token-hero">
        <div style={{ minWidth: 0, flex: 1 }}>
          <h1 className="rk-h1" style={{ fontSize: "clamp(1.6rem, 3.4vw, 2.2rem)", marginBottom: 10 }}>
            {displayName}
            {summary.symbol && summary.name ? (
              <span className="rk-faint" style={{ fontWeight: 400, fontSize: "0.62em" }}> {summary.symbol}</span>
            ) : null}
          </h1>
          <div className="rk-row">
            <CopyAddress address={summary.address ?? addr} />
            {!summary.isVerified && <span className="rk-chip">Unverified source</span>}
            {summary.isProxy && <span className="rk-chip">Upgradeable proxy</span>}
            {data.stale && !data.analysisPending && <span className="rk-chip">Result may be out of date</span>}
            {data.analysisPending && <span className="rk-chip">Analysis queued</span>}
          </div>
        </div>
        <div className="rk-row">
          {updated && (
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-3)", marginRight: 4, textTransform: "uppercase" }}>
              Updated {updated}
            </span>
          )}
          <AnalyzeButton address={addr} />
          {data.explorerAddress && (
            <a className="rk-btn rk-btn--sm" href={data.explorerAddress} target="_blank" rel="noreferrer">
              Explorer &#8599;
            </a>
          )}
        </div>
      </header>

      <Reveal as="section" className="rk-verdict">
        <div className="rk-verdict__main">
          <p className="rk-eyebrow">Risk assessment</p>
          <div className="rk-verdict__dial">
            <span className="rk-dial-big">
              <svg viewBox="0 0 132 132" width="118" height="118" fill="none" aria-hidden="true">
                <path d={DIAL_PATH} stroke="var(--surface-3)" strokeWidth="8" strokeLinecap="round" />
                {/* Dash values are inline so the ring still shows the real score
                    where the draw animation never runs (no scroll timeline,
                    reduced motion). */}
                <path
                  className="rk-reveal rk-reveal--draw"
                  d={DIAL_PATH}
                  stroke={tone}
                  strokeWidth="8"
                  strokeLinecap="round"
                  style={{
                    strokeDasharray: ARC_LEN,
                    strokeDashoffset: offset,
                    ["--len" as string]: String(ARC_LEN),
                    ["--off" as string]: String(offset),
                  }}
                />
              </svg>
              <span>
                <b style={{ color: score == null ? "var(--text-3)" : tone }}>{score ?? "--"}</b>
                <em>{score == null ? "not scored" : "of 100"}</em>
              </span>
            </span>
            <span style={{ minWidth: 0 }}>
              {report ? <RiskBadge risk={report.overall} /> : <span className="rk-chip">Not checked</span>}
              <span style={{ display: "block", marginTop: 8, fontSize: 12.5, lineHeight: 1.45, color: "var(--text-3)" }}>
                Highest category score across every check that returned evidence.
              </span>
            </span>
          </div>

          <p style={{ margin: "0 0 16px", fontSize: 13.5, lineHeight: 1.55, color: "var(--text-2)" }}>
            {simulation?.summary ? friendlySignal(simulation.summary) : sellStory}
          </p>

          <div className="rk-verdict__meta">
            <div><span>Confidence</span><span style={{ fontWeight: 550, textTransform: "capitalize" }}>{report?.confidence ?? "Unknown"}</span></div>
            <div><span>Findings</span><span className="rk-mono">{findingCount}</span></div>
            <div><span>Overall</span><span style={{ fontWeight: 550 }}>{riskLabel(report?.overall)}</span></div>
          </div>
        </div>

        <dl className="rk-facts" style={{ margin: 0 }}>
          <div>
            <dt>Sell check</dt>
            <dd style={{ color: sellTone }}>{sellLabel}</dd>
            <p>Fresh-address round trip on the sell leg</p>
          </div>
          <div>
            <dt>Buy check</dt>
            <dd style={{ color: buyTone }}>{buyLabel}</dd>
            <p>Buy leg of the same simulation</p>
          </div>
          <div>
            <dt>Top 3 hold</dt>
            <dd style={{ color: top3 >= 50 ? "var(--red)" : top3 >= 25 ? "var(--amber)" : undefined }}>
              {ranked.length ? `${top3.toFixed(1)}%` : "Unknown"}
            </dd>
            <p>
              {ranked.length
                ? `Top 10 hold ${top10.toFixed(1)}%`
                : holders.length
                  ? `${holders.length} holders listed, shares unknown`
                  : "Holder list not available"}
            </p>
          </div>
          <div>
            <dt>Liquidity</dt>
            <dd>{liq ?? "Unknown"}</dd>
            <p>{liq ? "Pool value known to the indexer" : "No pool data for this token yet"}</p>
          </div>
        </dl>
      </Reveal>

      {categories.length > 0 && (
        <Reveal as="section" className="rk-panel">
          <div className="rk-panel-head">
            <span>Category breakdown</span>
            <span style={{ color: "var(--text-4)" }}>Score 0-100</span>
          </div>
          {categories.map((c) => (
            <div key={c.category} className="rk-catrow">
              <span>{categoryLabel(c.category)}</span>
              <span className="rk-catrow__hint">{c.score === 0 ? "Nothing flagged" : friendlySignal(c.explanation)}</span>
              <span className="rk-score__bar">
                <i className="rk-reveal rk-reveal--growX" style={{ width: `${Math.min(100, Math.max(c.score, 6))}%`, background: toneFor(c.score) }} />
              </span>
              <span className="rk-catrow__score" style={{ color: toneFor(c.score) }}>{c.score}</span>
            </div>
          ))}
          <p className="rk-panel__note" style={{ margin: 0 }}>
            A clear category is not a safety guarantee, it only means nothing was flagged with the evidence available.
          </p>
        </Reveal>
      )}

      <div className="rk-grid-2" style={{ alignItems: "start" }}>
        <Reveal as="section" className="rk-panel">
          <div className="rk-panel-head">
            <span>Findings</span>
            <span style={{ color: "var(--text-4)" }}>
              {findingCount > topFindings.length ? `${topFindings.length} of ${findingCount} shown` : `${findingCount} recorded`}
            </span>
          </div>
          {topFindings.map((f, i) => {
            const proof = (Array.isArray(f.evidence) ? f.evidence : f.evidenceJson) ?? [];
            return (
              <article key={f.id ?? i} className={`rk-finding rk-finding--${f.severity || "info"}`} style={{ border: 0, borderRadius: 0, borderBottom: "1px solid var(--line)", borderLeftWidth: 3 }}>
                <div className="rk-between">
                  <strong style={{ fontSize: 13.5 }}>{friendlySignal(f.name)}</strong>
                  <span className={`rk-badge rk-badge--${f.severity === "critical" ? "critical" : f.severity === "high" ? "high" : f.severity === "medium" ? "caution" : "ok"}`}>
                    {severityLabel(f.severity)}
                  </span>
                </div>
                <p>{friendlySignal(f.summary)}</p>
                {f.whyItMatters && (
                  <p className="rk-faint" style={{ fontSize: 12.5 }}>
                    <span style={{ color: "var(--text-4)" }}>Why it matters: </span>{f.whyItMatters}
                  </p>
                )}
                {proof.length > 0 && (
                  <details className="rk-proof">
                    <summary>Evidence</summary>
                    <ul>
                      {proof.slice(0, 4).map((e, j) => (
                        <li key={j}>
                          {e.url ? (
                            <a href={e.url} target="_blank" rel="noreferrer">{e.label ?? "Open reference"}</a>
                          ) : (
                            <span>{e.type}: {shortAddr(e.value) || e.value}</span>
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
            <p className="rk-panel__note" style={{ margin: 0 }}>
              {data.analysisPending ? "Risk analysis is queued. Refresh shortly to see the evidence." : "No specific flags stored yet."}
            </p>
          )}
        </Reveal>

        <div className="rk-stack">
          <Reveal as="section" className="rk-panel">
            <div className="rk-panel-head"><span>Buy / sell simulation</span></div>
            <div style={{ padding: 16 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1, background: "var(--line)", border: "1px solid var(--line)", borderRadius: "var(--r-sm)", overflow: "hidden", marginBottom: 13 }}>
                <div style={{ padding: 12, background: "var(--surface)" }}>
                  <div className="rk-field-label" style={{ marginBottom: 6 }}>Buy</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 14, fontWeight: 600, color: buyTone }}>
                    <i style={{ width: 7, height: 7, borderRadius: "50%", background: "currentColor" }} />{buyLabel}
                  </div>
                </div>
                <div style={{ padding: 12, background: "var(--surface)" }}>
                  <div className="rk-field-label" style={{ marginBottom: 6 }}>Sell</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 14, fontWeight: 600, color: sellTone }}>
                    <i style={{ width: 7, height: 7, borderRadius: "50%", background: "currentColor" }} />{sellLabel}
                  </div>
                </div>
              </div>
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: "var(--text-2)" }}>{sellStory}</p>
              {steps.length > 0 && (
                <div style={{ marginTop: 12, borderTop: "1px solid var(--line)" }}>
                  {steps.map((s, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: "1px solid var(--line)" }}>
                      <span
                        aria-hidden="true"
                        style={{
                          width: 16, height: 16, flexShrink: 0, display: "grid", placeItems: "center", borderRadius: 3,
                          fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 600,
                          background: s.success ? "color-mix(in srgb, var(--green) 16%, var(--surface))" : "color-mix(in srgb, var(--red) 16%, var(--surface))",
                          color: s.success ? "var(--green)" : "var(--red)",
                        }}
                      >
                        {s.success ? "\u2713" : "\u00d7"}
                      </span>
                      <span style={{ fontSize: 12.5, color: "var(--text-2)" }}>{s.step}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Reveal>

          <Reveal as="section" className="rk-panel">
            <div className="rk-panel-head"><span>Creator</span></div>
            <div style={{ padding: 16 }}>
              {creatorWarnings.length > 0 && (
                <div className="rk-alert" role="alert" style={{ marginBottom: 14 }}>
                  <strong>Concerning creator history found</strong>
                  {creatorWarnings.slice(0, 3).map((w, i) => {
                    const proof = w.evidence ?? w.evidenceJson ?? [];
                    const source = proof.find((p) => p.url);
                    return (
                      <div key={w.id ?? i} style={{ marginTop: 8 }}>
                        <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.45 }}>{friendlySignal(w.summary)}</p>
                        {source?.url && (
                          <a href={source.url} target="_blank" rel="noreferrer" className="rk-evidence-link">Review evidence &rarr;</a>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="rk-verdict__meta" style={{ borderTop: "1px solid var(--line)" }}>
                <div>
                  <span>Deployer</span>
                  {summary.deployer ? (
                    <Link href={`/wallet/${summary.deployer}`} className="rk-mono">{shortAddr(summary.deployer)}</Link>
                  ) : (
                    <span className="rk-faint">Not identified</span>
                  )}
                </div>
                {summary.owner && (
                  <div>
                    <span>Owner</span>
                    <Link href={`/wallet/${summary.owner}`} className="rk-mono">{shortAddr(summary.owner)}</Link>
                  </div>
                )}
                {deployerProfile?.ageDays != null && (
                  <div><span>Wallet age</span><span className="rk-mono">{deployerProfile.ageDays} days</span></div>
                )}
                {deployerProfile?.historyLabel && (
                  <div>
                    <span>History</span>
                    <span style={{ fontWeight: 550 }}>
                      {deployerProfile.historyLabel === "limited_history" ? "Limited" : deployerProfile.historyLabel === "established" ? "Established" : deployerProfile.historyLabel}
                    </span>
                  </div>
                )}
                {liq && <div><span>Liquidity (known)</span><span className="rk-mono">{liq}</span></div>}
              </div>
            </div>
          </Reveal>

          <Link href="/appeals" className="rk-card rk-card--link" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <span style={{ minWidth: 0 }}>
              <strong style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 2 }}>Think a finding is wrong?</strong>
              <span style={{ fontSize: 12.5, color: "var(--text-3)" }}>Submit evidence for manual review.</span>
            </span>
            <span className="rk-mono" style={{ color: "var(--text-3)" }}>&rarr;</span>
          </Link>
        </div>
      </div>

      <Reveal as="section" className="rk-panel">
        <div className="rk-panel-head">
          <span>Supply distribution</span>
          {/* Say what is actually on screen, not just the stored count. */}
          <span style={{ color: "var(--text-4)" }}>
            {summary.holderCount != null && summary.holderCount > holders.length
              ? `${holders.length} of ${summary.holderCount.toLocaleString("en-US")} holders shown`
              : `${holders.length.toLocaleString("en-US")} holders tracked`}
          </span>
        </div>

        {holders.length === 0 ? (
          <p className="rk-panel__note" style={{ margin: 0 }}>Holder list not available yet for this token.</p>
        ) : (
          <>
            {/* The share bar needs percentages. The holder list does not, so it
                must not disappear when total supply is unknown. */}
            {tracked.length > 0 ? (
              <div style={{ padding: "18px 16px 16px" }}>
                <div className="rk-supply">
                  {tracked.map((h, i) => (
                    <span
                      key={h.address}
                      className="rk-reveal rk-reveal--growX"
                      title={`${shortAddr(h.address)}: ${(h.pct ?? 0).toFixed(2)}%`}
                      style={{
                        width: `${h.pct ?? 0}%`,
                        background: h.labels?.includes("deployer")
                          ? "var(--red)"
                          : `color-mix(in srgb, var(--blue) ${Math.max(28, 96 - i * 8)}%, var(--surface-2))`,
                      }}
                    />
                  ))}
                  {rest > 0 && <span style={{ width: `${rest}%`, background: "var(--surface-3)" }} title={`Remaining supply: ${rest.toFixed(1)}%`} />}
                </div>
                <div className="rk-supply-legend">
                  <span><i style={{ background: "var(--red)" }} />Creator</span>
                  <span><i style={{ background: "var(--blue)" }} />Top holders</span>
                  <span><i style={{ background: "var(--surface-3)" }} />Remaining supply</span>
                </div>
              </div>
            ) : (
              <p className="rk-panel__note" style={{ margin: "14px 16px 0" }}>
                Total supply is unknown for this token, so ownership shares cannot be calculated.
                Balances are listed below as returned by the explorer.
              </p>
            )}

            <div className="rk-table-wrap">
              <table className="rk-table">
                <thead>
                  <tr><th>Wallet</th><th style={{ textAlign: "right" }}>Share</th><th style={{ textAlign: "right" }}>Balance</th></tr>
                </thead>
                <tbody>
                  {holders.map((h) => (
                    <tr key={h.address}>
                      <td>
                        <Link href={`/wallet/${h.address}`} className="rk-mono">{shortAddr(h.address)}</Link>
                        {h.labels?.includes("deployer") && <span className="rk-chip" style={{ marginLeft: 8 }}>Creator</span>}
                        {h.labels?.includes("known_service") && <span className="rk-chip" style={{ marginLeft: 8 }}>Service</span>}
                      </td>
                      <td style={{ textAlign: "right" }} className="rk-mono">{h.pct != null ? `${h.pct.toFixed(2)}%` : "-"}</td>
                      <td style={{ textAlign: "right" }} className="rk-mono rk-faint">
                        {h.balance.length > 16 ? `${h.balance.slice(0, 10)}…` : h.balance}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Reveal>
    </div>
  );
}
