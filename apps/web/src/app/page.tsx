import Link from "next/link";
import { apiGet, type TokenSummary } from "@/lib/api";
import { TokenCard } from "@/components/TokenCard";
import { HomeSearch } from "@/components/HomeSearch";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  let tokens: TokenSummary[] = [];
  let err: string | null = null;

  try {
    const data = await apiGet<{ items: TokenSummary[] }>("/tokens?limit=6&sort=newest");
    tokens = data.items ?? [];
  } catch (e) {
    err = e instanceof Error ? e.message : "Could not load tokens";
  }

  return (
    <div className="rk-stack-lg">
      <section className="rk-hero">
        <h1 className="rk-h1">Know the risk before you touch a token</h1>
        <p className="rk-lead">
          An early-warning layer for sell traps, hidden control, concentrated supply, removable liquidity,
          and creator history. Every warning links back to evidence.
        </p>
        <HomeSearch />
        <Link className="rk-hero__text-link" href="/feed">Browse recently discovered tokens</Link>
      </section>

      <section className="rk-features">
        <div className="rk-feature">
          <span className="rk-feature__num">01</span>
          <h3>Can holders exit?</h3>
          <p>Sell paths, freezes, blacklists, transfer restrictions, and honeypot patterns.</p>
        </div>
        <div className="rk-feature">
          <span className="rk-feature__num">02</span>
          <h3>Who can change the rules?</h3>
          <p>Owner privileges, proxy upgrades, mint controls, concentrated bags, and removable liquidity.</p>
        </div>
        <div className="rk-feature">
          <span className="rk-feature__num">03</span>
          <h3>Does the history repeat?</h3>
          <p>Prior launches, funding paths, linked wallets, and confirmed harmful history when evidence exists.</p>
        </div>
      </section>

      <section>
        <div className="rk-section-head">
          <h2 className="rk-h2">New on Arc</h2>
          <Link href="/feed" className="rk-btn rk-btn--sm rk-btn--ghost">
            See all
          </Link>
        </div>

        {err && <div className="rk-alert">{err}</div>}

        {!err && tokens.length === 0 && (
          <div className="rk-card rk-empty">
            <strong>Nothing here yet</strong>
            Paste a token address above to run the first check.
            <div className="mt-2">
              <Link className="rk-btn rk-btn--primary rk-btn--sm" href="/scan">
                Check a token
              </Link>
            </div>
          </div>
        )}

        <div className="rk-grid-2">
          {tokens.map((t) => (
            <TokenCard key={t.id} t={t} />
          ))}
        </div>
      </section>
    </div>
  );
}
