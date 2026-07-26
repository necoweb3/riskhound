import Link from "next/link";
import { apiGet, shortAddr, type TokenSummary } from "@/lib/api";
import { TokenCard } from "@/components/TokenCard";
import { HomeSearch } from "@/components/HomeSearch";
import { Reveal } from "@/components/Reveal";
import { CountUp } from "@/components/CountUp";
import { EnforcedInCode } from "@/components/EnforcedInCode";

export const dynamic = "force-dynamic";

const PIPELINE = [
  {
    n: "01",
    title: "Read the contract",
    body: "Bytecode, callable surface, ownership slots and proxy pointers pulled straight from the node.",
  },
  {
    n: "02",
    title: "Simulate the round trip",
    body: "A fresh address buys, then sells. Whatever reverts is recorded with its gas trace.",
  },
  {
    n: "03",
    title: "Map the money",
    body: "Holders, LP positions, first funders and same-block clusters are linked into one graph.",
  },
  {
    n: "04",
    title: "Publish with evidence",
    body: "Every signal ships with its source, confidence and the transaction that produced it.",
  },
];

const COVERAGE = [
  { n: "01", title: "Exit risk", body: "Sell-path failures, transfer restrictions, freezes, blacklists and honeypot-like behaviour." },
  { n: "02", title: "Contract control", body: "Ownership, administrative powers, proxy upgrades, mint authority and dangerous callable functions." },
  { n: "03", title: "Liquidity", body: "Pool visibility, LP concentration, removable exit liquidity and suspicious add or remove events." },
  { n: "04", title: "Supply ownership", body: "Top-holder concentration, deployer holdings, linked wallets and insider clusters." },
  { n: "05", title: "Creator history", body: "Previous deployments, first funders, connected addresses and evidence-confirmed harmful activity." },
  { n: "06", title: "Bridge intelligence", body: "Arc-targeted CCTP burns, Circle attestation state, observed mint state and high-value recipients." },
];

const DIAL = "M27.8 104.2 A54 54 0 1 1 104.2 104.2";
/** Length of the 270 degree arc above, so the dial can be filled by score. */
const DIAL_LEN = 2 * Math.PI * 54 * 0.75;

/** The verdict label takes its colour from the verdict, not from the layout. */
const RISK_TONE: Record<string, string> = {
  critical_risk: "var(--red)",
  high_risk: "var(--amber)",
  caution: "var(--yellow)",
  low_detected_risk: "var(--green)",
  insufficient_data: "var(--text-3)",
};

const TONE: Record<string, string> = {
  green: "var(--green)",
  amber: "var(--amber)",
  red: "var(--red)",
  muted: "var(--text-3)",
};

type Stats = {
  counts: { contractsIndexed: number; findingsWithEvidence: number; creatorsTracked: number };
  latest: {
    address: string;
    symbol: string | null;
    score: number | null;
    overall: string | null;
    overallLabel: string | null;
    headline: string | null;
    rows: { label: string; value: string; tone: string }[];
  } | null;
};

export default async function HomePage() {
  let tokens: TokenSummary[] = [];
  let err: string | null = null;
  let stats: Stats | null = null;

  const [tokenRes, statsRes] = await Promise.allSettled([
    apiGet<{ items: TokenSummary[] }>("/tokens?limit=6&sort=newest"),
    apiGet<Stats>("/stats"),
  ]);

  if (tokenRes.status === "fulfilled") {
    tokens = tokenRes.value.items ?? [];
  } else {
    err =
      tokenRes.reason instanceof Error ? tokenRes.reason.message : "Could not load tokens";
  }
  // Counters and the live panel are omitted rather than faked when /stats is down.
  if (statsRes.status === "fulfilled") stats = statsRes.value;

  const latest = stats?.latest ?? null;
  const dialScore = latest?.score ?? null;

  return (
    <div>
      <section className="rk-hero-grid">
        <div className="rk-hero-copy">
          <h1>Evidence before exposure.</h1>
          <p className="rk-lead" style={{ marginBottom: 32 }}>
            RiskHound reads the chain, not the narrative. Sell traps, hidden control, concentrated supply,
            removable liquidity and creator history, each signal linked to the transaction that proves it.
          </p>
          <HomeSearch />
          <p className="rk-hero-note">READ-ONLY &nbsp;&middot;&nbsp; NO WALLET CONNECTION &nbsp;&middot;&nbsp; NO KEYS, EVER</p>

          {stats && (
            <Reveal className="rk-hero-stats">
              <div>
                <b><CountUp value={stats.counts.contractsIndexed} /></b>
                <span>Contracts indexed</span>
              </div>
              <div>
                <b><CountUp value={stats.counts.findingsWithEvidence} /></b>
                <span>Findings with proof</span>
              </div>
              <div>
                <b><CountUp value={stats.counts.creatorsTracked} /></b>
                <span>Creators tracked</span>
              </div>
            </Reveal>
          )}
        </div>

        {latest && (
          <Reveal className="rk-live">
            <span className="rk-live__scan" aria-hidden="true" />
            <div className="rk-live__head">
              <b>Last analysis</b>
              <Link href={`/token/${latest.address}`}>{shortAddr(latest.address)}</Link>
            </div>
            <div className="rk-live__rows">
              {latest.rows.map((r, i) => (
                <div key={r.label} className="rk-live__row" style={{ animationDelay: `${i * 0.55}s` }}>
                  <span>{r.label}</span>
                  <em style={{ color: TONE[r.tone] ?? "var(--text-3)" }}>{r.value}</em>
                </div>
              ))}
            </div>
            <div className="rk-live__foot">
              <span className="rk-live__dial">
                <svg viewBox="0 0 132 132" width="58" height="58" fill="none" aria-hidden="true">
                  <path d={DIAL} stroke="var(--surface-3)" strokeWidth="11" strokeLinecap="round" />
                  {dialScore != null && (
                    <path
                      d={DIAL}
                      stroke={dialScore >= 70 ? "var(--red)" : dialScore >= 40 ? "var(--amber)" : "var(--green)"}
                      strokeWidth="11"
                      strokeLinecap="round"
                      strokeDasharray={DIAL_LEN}
                      strokeDashoffset={DIAL_LEN * (1 - Math.min(100, Math.max(0, dialScore)) / 100)}
                    />
                  )}
                </svg>
                <span>{dialScore ?? "--"}</span>
              </span>
              <span className="rk-live__verdict">
                <strong style={{ color: RISK_TONE[latest.overall ?? ""] ?? "var(--text)" }}>
                  {latest.overallLabel ?? "Not scored"}
                </strong>
                <span>{latest.headline ?? "No findings recorded for this contract."}</span>
              </span>
            </div>
          </Reveal>
        )}
      </section>

      <section className="rk-section">
        <div className="rk-section-head">
          <h2 className="rk-h2" style={{ fontSize: 23, letterSpacing: "-0.02em" }}>New on Arc</h2>
          <Link href="/feed" className="rk-btn rk-btn--sm rk-btn--ghost">See all</Link>
        </div>

        {err && <div className="rk-alert">{err}</div>}

        {!err && tokens.length === 0 && (
          <div className="rk-card rk-empty">
            <strong>Nothing here yet</strong>
            Paste a token address above to run the first check.
            <div className="mt-2">
              <Link className="rk-btn rk-btn--primary rk-btn--sm" href="/scan">Check a token</Link>
            </div>
          </div>
        )}

        <div className="rk-grid-2">
          {tokens.map((t) => (
            <Reveal key={t.id} variant="sm">
              <TokenCard t={t} />
            </Reveal>
          ))}
        </div>
      </section>

      <section className="rk-section">
        <p className="rk-eyebrow">Pipeline</p>
        <h2 style={{ margin: "0 0 30px", fontSize: 23, fontWeight: 600, letterSpacing: "-0.02em" }}>
          From block to verdict in four passes
        </h2>
        <div className="rk-pipeline">
          <span className="rk-pipeline__track" aria-hidden="true" />
          <Reveal as="span" variant="growX" className="rk-pipeline__track rk-pipeline__track--live" aria-hidden="true" />
          <span className="rk-pipeline__pulse" aria-hidden="true"><i /></span>
          <div className="rk-pipeline__steps">
            {PIPELINE.map((s) => (
              <Reveal key={s.n} variant="sm">
                <b>{s.n}</b>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section className="rk-section">
        <p className="rk-eyebrow">Coverage</p>
        <h2 style={{ margin: "0 0 26px", fontSize: 23, fontWeight: 600, letterSpacing: "-0.02em" }}>
          Six questions, answered from chain data
        </h2>
        <div className="rk-features">
          {COVERAGE.map((c) => (
            <div key={c.n} className="rk-feature">
              <span className="rk-feature__num">{c.n}</span>
              <h3>{c.title}</h3>
              <p>{c.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="rk-section">
        <div className="rk-section__intro">
          <p className="rk-eyebrow">Enforced in code</p>
          <h2>Rules we do not bend</h2>
          <p>
            Risk scores are never generated, inferred or softened. Pick a rule to see the guard that
            implements it.
          </p>
        </div>
        <Reveal>
          <EnforcedInCode />
        </Reveal>
      </section>

      <section className="rk-section">
        <Reveal className="rk-cta">
          <div>
            <h2>Check a contract before you touch it</h2>
            <p>Arc Testnet analysis is free and requires no account.</p>
          </div>
          <div className="rk-row">
            <Link href="/scan" className="rk-btn rk-btn--primary">Run a check</Link>
            <Link href="/feed" className="rk-btn">Browse discovered tokens</Link>
          </div>
        </Reveal>
      </section>
    </div>
  );
}
