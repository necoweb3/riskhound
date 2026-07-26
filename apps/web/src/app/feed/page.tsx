import Link from "next/link";
import { apiGet, riskLabel, type TokenSummary } from "@/lib/api";
import { TokenRow } from "@/components/TokenRow";
import { Reveal } from "@/components/Reveal";

export const dynamic = "force-dynamic";

const SORTS = [
  { id: "newest", label: "Newest" },
  { id: "high_risk", label: "Higher risk" },
  { id: "critical", label: "Critical" },
  { id: "holders", label: "Most holders" },
];

const MIX = [
  { key: "critical_risk", color: "var(--red)" },
  { key: "high_risk", color: "var(--amber)" },
  { key: "caution", color: "var(--yellow)" },
  { key: "low_detected_risk", color: "var(--green)" },
  { key: "insufficient_data", color: "var(--text-4)" },
];

export default async function FeedPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string; q?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const sort = sp.sort ?? "newest";
  const q = sp.q ?? "";
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  const pageSize = 40;

  let items: TokenSummary[] = [];
  let total = 0;
  let err: string | null = null;

  try {
    const data = await apiGet<{ items: TokenSummary[]; total: number }>(
      `/tokens?sort=${encodeURIComponent(sort)}&q=${encodeURIComponent(q)}&limit=${pageSize}&offset=${(page - 1) * pageSize}`,
    );
    items = data.items;
    total = data.total;
  } catch (e) {
    err = e instanceof Error ? e.message : "Could not load feed";
  }

  // Risk mix is counted from the rows actually loaded, never extrapolated.
  const counts = MIX.map((m) => ({
    ...m,
    label: riskLabel(m.key),
    n: items.filter((t) => (t.overallRisk ?? "insufficient_data") === m.key).length,
  }));
  const maxN = Math.max(1, ...counts.map((c) => c.n));
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const qs = (over: Record<string, string | number>) =>
    `/feed?${new URLSearchParams({ sort, q, page: String(page), ...Object.fromEntries(Object.entries(over).map(([k, v]) => [k, String(v)])) }).toString()}`;

  return (
    <div className="rk-stack-lg">
      <header className="rk-between" style={{ alignItems: "flex-end" }}>
        <div>
          <p className="rk-eyebrow">Token inventory</p>
          <h1 className="rk-h1" style={{ margin: 0, fontSize: 26 }}>Discover</h1>
        </div>
        <nav className="rk-filters" aria-label="Network">
          <Link href="/feed" className="is-active">Arc Testnet</Link>
          <Link href="/mainnet">Observed Arc 5042</Link>
        </nav>
      </header>

      {items.length > 0 && (
        <Reveal className="rk-card" style={{ padding: "16px 18px", maxWidth: 520 }}>
          <div className="rk-chart-head">
            <span>Risk mix on this page</span>
            <span style={{ color: "var(--text-4)" }}>{items.length} rows</span>
          </div>
          {counts.map((c) => (
            <div key={c.key} className="rk-mix">
              <span>{c.label}</span>
              <span className="rk-mix__bar">
                <i
                  className="rk-reveal rk-reveal--growX"
                  style={{ width: `${Math.round((c.n / maxN) * 100)}%`, background: c.color }}
                />
              </span>
              <span className="rk-mix__n">{c.n}</span>
              <span className="rk-mix__pct">{items.length ? `${((c.n / items.length) * 100).toFixed(1)}%` : "0%"}</span>
            </div>
          ))}
        </Reveal>
      )}

      <div className="rk-row" style={{ gap: 8 }}>
        <form className="rk-search" action="/feed" method="get" style={{ flex: 1, minWidth: 220, maxWidth: 400 }}>
          <input
            className="rk-input"
            name="q"
            defaultValue={q}
            placeholder="Search name or address…"
            aria-label="Search"
            autoComplete="off"
            style={{ height: 34 }}
          />
          <input type="hidden" name="sort" value={sort} />
        </form>

        <div className="rk-filters">
          {SORTS.map((s) => (
            <Link key={s.id} href={qs({ sort: s.id, page: 1 })} className={sort === s.id ? "is-active" : ""}>
              {s.label}
            </Link>
          ))}
        </div>

        <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.04em", color: "var(--text-3)" }}>
          {total.toLocaleString("en-US")} TOKEN{total === 1 ? "" : "S"}
        </span>
      </div>

      {err && <div className="rk-alert">{err}</div>}

      {!err && items.length === 0 && (
        <div className="rk-card rk-empty">
          <strong>No matches</strong>
          Try another filter or check a token directly.
        </div>
      )}

      {items.length > 0 && (
        <div className="rk-tokentable">
          <div className="rk-tokentable__head">
            <span>Token</span>
            <span>Risk</span>
            <span>Leading signal</span>
            <span style={{ textAlign: "right" }}>Holders</span>
            <span style={{ textAlign: "right" }}>Liquidity</span>
            <span style={{ textAlign: "right" }}>Created</span>
          </div>

          {items.map((t) => (
            <TokenRow key={t.id} t={t} />
          ))}

          <div className="rk-tokentable__foot">
            <span>PAGE {page} / {pages}</span>
            <div className="rk-row" style={{ gap: 6 }}>
              {page > 1 ? (
                <Link className="rk-btn rk-btn--sm" href={qs({ page: page - 1 })}>Previous</Link>
              ) : (
                <span className="rk-btn rk-btn--sm" aria-disabled="true" style={{ opacity: 0.45, cursor: "not-allowed" }}>Previous</span>
              )}
              {page < pages ? (
                <Link className="rk-btn rk-btn--sm" href={qs({ page: page + 1 })}>Next</Link>
              ) : (
                <span className="rk-btn rk-btn--sm" aria-disabled="true" style={{ opacity: 0.45, cursor: "not-allowed" }}>Next</span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
