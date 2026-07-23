import Link from "next/link";
import { apiGet, type TokenSummary } from "@/lib/api";
import { TokenCard } from "@/components/TokenCard";

export const dynamic = "force-dynamic";

const SORTS = [
  { id: "newest", label: "Newest" },
  { id: "high_risk", label: "Higher risk" },
  { id: "critical", label: "Critical" },
  { id: "holders", label: "Most holders" },
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
      `/tokens?sort=${encodeURIComponent(sort)}&q=${encodeURIComponent(q)}&limit=${pageSize}&offset=${(page - 1) * pageSize}`
    );
    items = data.items;
    total = data.total;
  } catch (e) {
    err = e instanceof Error ? e.message : "Could not load feed";
  }

  return (
    <div className="rk-stack-lg">
      <header className="rk-page-title">
        <h1 className="rk-h1" style={{ fontSize: "clamp(2rem, 5vw, 2.75rem)" }}>
          Discover
        </h1>
      </header>

      <nav className="rk-filters" aria-label="Network">
        <Link href="/feed" className="is-active">Arc Testnet</Link>
        <Link href="/mainnet">Observed Arc 5042</Link>
      </nav>

      <form className="rk-search" action="/feed" method="get">
        <input
          className="rk-input"
          name="q"
          defaultValue={q}
          placeholder="Search name or address…"
          aria-label="Search"
          autoComplete="off"
        />
        <input type="hidden" name="sort" value={sort} />
        <button className="rk-btn rk-btn--primary" type="submit">
          Search
        </button>
      </form>

      <div>
        <div className="rk-filters">
          {SORTS.map((s) => (
            <Link
              key={s.id}
              href={`/feed?sort=${s.id}&q=${encodeURIComponent(q)}`}
              className={sort === s.id ? "is-active" : ""}
            >
              {s.label}
            </Link>
          ))}
        </div>
      </div>

      <p className="rk-faint" style={{ margin: 0, fontSize: "0.85rem" }}>
        {total} token{total === 1 ? "" : "s"}
      </p>

      {err && <div className="rk-alert">{err}</div>}
      {!err && items.length === 0 && (
        <div className="rk-card rk-empty">
          <strong>No matches</strong>
          Try another filter or check a token directly.
        </div>
      )}

      <div className="rk-grid-2">
        {items.map((t) => (
          <TokenCard key={t.id} t={t} />
        ))}
      </div>

      {!err && total > pageSize && (
        <nav className="rk-between" aria-label="Token list pages">
          <span className="rk-faint">Page {page} of {Math.ceil(total / pageSize)}</span>
          <div className="rk-filters">
            {page > 1 && <Link href={`/feed?sort=${encodeURIComponent(sort)}&q=${encodeURIComponent(q)}&page=${page - 1}`}>Previous</Link>}
            {page * pageSize < total && <Link href={`/feed?sort=${encodeURIComponent(sort)}&q=${encodeURIComponent(q)}&page=${page + 1}`}>Next</Link>}
          </div>
        </nav>
      )}
    </div>
  );
}
