import Link from "next/link";
import { apiGet, friendlySignal, riskClass, riskLabel, shortAddr } from "@/lib/api";

export const dynamic = "force-dynamic";

type ObservedSignal = { severity: string; name: string; detail: string };
type MainnetTokens = {
  items: Array<{
    address: string;
    name: string | null;
    symbol: string | null;
    holderCount: number | null;
    explorerUrl: string;
    riskAssessment?: {
      level: string;
      confidence: string;
      signals: ObservedSignal[];
    };
  }>;
  nextCursor: string | null;
};

const SORTS = [
  { id: "newest", label: "Newest" },
  { id: "high_risk", label: "Higher risk" },
  { id: "critical", label: "Critical" },
  { id: "holders", label: "Most holders" },
];

const RISK_ORDER: Record<string, number> = {
  critical_risk: 4,
  high_risk: 3,
  caution: 2,
  lower_observed_risk: 1,
};

export default async function MainnetPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string; sort?: string; q?: string }>;
}) {
  const { cursor, sort = "newest", q = "" } = await searchParams;
  let data: MainnetTokens | null = null;
  let error: string | null = null;
  try {
    data = await apiGet<MainnetTokens>(
      `/observed-mainnet/tokens?sort=${encodeURIComponent(sort)}&q=${encodeURIComponent(q)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
    );
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "Could not load observed tokens.";
  }

  const needle = q.trim().toLowerCase();
  let visibleItems = (data?.items ?? []).filter((token) =>
    !needle || token.address.includes(needle) || token.name?.toLowerCase().includes(needle) || token.symbol?.toLowerCase().includes(needle)
  );
  if (sort === "critical") visibleItems = visibleItems.filter((token) => token.riskAssessment?.level === "critical_risk");
  if (sort === "holders") visibleItems.sort((a, b) => (b.holderCount ?? -1) - (a.holderCount ?? -1));
  if (sort === "high_risk") visibleItems.sort((a, b) => (RISK_ORDER[b.riskAssessment?.level ?? ""] ?? 0) - (RISK_ORDER[a.riskAssessment?.level ?? ""] ?? 0));

  return (
    <div className="rk-stack-lg">
      <header style={{ maxWidth: 680 }}>
        <span className="rk-eyebrow">CHAIN 5042 · OBSERVED</span>
        <h1 className="rk-h1" style={{ fontSize: "clamp(2rem, 5vw, 2.75rem)" }}>
          Arc token inventory
        </h1>
        <p className="rk-lead">
          ERC-20 contracts indexed on the observable Arc network. Signals use only evidence currently
          available from chain 5042 and do not imply an official network announcement.
        </p>
      </header>

      <nav className="rk-filters" aria-label="Network">
        <Link href="/feed">Arc Testnet</Link>
        <Link href="/mainnet" className="is-active">Observed Arc 5042</Link>
      </nav>

      <form className="rk-search" action="/mainnet" method="get">
        <input className="rk-input" name="q" defaultValue={q} placeholder="Search name or address…" aria-label="Search observed tokens" autoComplete="off" />
        <input type="hidden" name="sort" value={sort} />
        <button className="rk-btn rk-btn--primary" type="submit">Search</button>
      </form>

      <nav className="rk-filters" aria-label="Sort observed tokens">
        {SORTS.map((item) => (
          <Link key={item.id} href={`/mainnet?sort=${item.id}&q=${encodeURIComponent(q)}`} className={sort === item.id ? "is-active" : ""}>
            {item.label}
          </Link>
        ))}
      </nav>

      {error && <div className="rk-alert" role="alert">{error}</div>}
      {data && (
        <>
          <div className="rk-grid-2">
            {visibleItems.map((token) => {
              const assessment = token.riskAssessment;
              const signals = assessment?.signals ?? [];
              return (
                <Link
                  className="rk-card rk-card--link rk-token"
                  href={`/mainnet/token/${token.address}`}
                  key={token.address}
                >
                  <div className="rk-token__top">
                    <div style={{ minWidth: 0 }}>
                      <h2 className="rk-token__name">
                        {token.name || token.symbol || "Unnamed token"}
                        {token.name && token.symbol ? (
                          <span style={{ color: "var(--text-4)", fontWeight: 500 }}> · {token.symbol}</span>
                        ) : null}
                      </h2>
                      <div className="rk-token__addr">{shortAddr(token.address)}</div>
                      <span className="rk-faint" style={{ fontSize: "0.72rem" }}>Observed Arc 5042</span>
                    </div>
                    <span className={riskClass(assessment?.level ?? "caution")}>
                      {riskLabel(assessment?.level ?? "caution")}
                    </span>
                  </div>

                  <div className="rk-token__meta">
                    {token.holderCount != null ? (
                      <span className="rk-chip">{token.holderCount.toLocaleString("en-US")} holders</span>
                    ) : (
                      <span className="rk-chip">Holder count unavailable</span>
                    )}
                    <span className="rk-chip">{assessment?.confidence ?? "low"} confidence</span>
                  </div>

                  <ul className="rk-token__signals">
                    {(signals.length ? signals : [{ name: "Full checks available in details" }])
                      .slice(0, 2)
                      .map((signal) => <li key={signal.name}>{friendlySignal(signal.name)}</li>)}
                  </ul>

                  <div className="rk-token__foot">
                    <span>Open risk breakdown</span>
                    <span aria-hidden="true">→</span>
                  </div>
                </Link>
              );
            })}
          </div>

          {!visibleItems.length && <div className="rk-card rk-empty"><strong>No matches</strong>Try another filter or search.</div>}

          <div className="rk-between">
            <span className="rk-faint">50 observed tokens per page</span>
            {data.nextCursor && (
              <Link className="rk-btn rk-btn--primary" href={`/mainnet?cursor=${encodeURIComponent(data.nextCursor)}&sort=${encodeURIComponent(sort)}&q=${encodeURIComponent(q)}`}>
                Next 50 tokens
              </Link>
            )}
          </div>
        </>
      )}
    </div>
  );
}
