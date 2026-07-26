import { apiGet } from "@/lib/api";

type SourceRow = {
  key: string;
  name: string;
  healthy: boolean;
  lastBlock?: string | null;
  lastSuccessAt?: string | null;
  lastError?: string | null;
};

type SourceStatus = { sources?: SourceRow[] };

const nf = new Intl.NumberFormat("en-US");

function ago(iso?: string | null) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return null;
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

/**
 * Thin infrastructure strip above the nav. Every value comes from
 * GET /status/sources, if the endpoint is unreachable the strip degrades to a
 * single honest "indexer unreachable" line rather than inventing numbers.
 */
export async function StatusBar() {
  let data: SourceStatus | null = null;
  try {
    data = await apiGet<SourceStatus>("/status/sources");
  } catch {
    data = null;
  }

  const sources = data?.sources ?? [];
  const total = sources.length;
  const ok = sources.filter((s) => s.healthy).length;

  // The strip speaks for Arc, so "live" may only come from a healthy Arc
  // source. A reachable status endpoint is not itself evidence of an indexer.
  const arc = sources.filter((s) => s.key.startsWith("arc"));
  const arcLive = arc.some((s) => s.healthy);

  const blocks = arc
    .filter((s) => s.healthy && s.lastBlock != null)
    .map((s) => Number(s.lastBlock))
    .filter((n) => Number.isFinite(n));
  const blockHeight = blocks.length ? Math.max(...blocks) : null;

  const successes = sources
    .map((s) => (s.lastSuccessAt ? new Date(s.lastSuccessAt).getTime() : Number.NaN))
    .filter((n) => !Number.isNaN(n));
  const refreshed = successes.length ? ago(new Date(Math.max(...successes)).toISOString()) : null;

  return (
    <div className="rk-statusbar">
      <div className="rk-statusbar__inner">
        {total === 0 ? (
          <span>ARC TESTNET · INDEXER STATUS UNAVAILABLE</span>
        ) : (
          <>
            {arcLive ? (
              <span className="rk-statusbar__live">ARC TESTNET · INDEXER LIVE</span>
            ) : (
              <span className="rk-statusbar__down">ARC TESTNET · INDEXER UNREACHABLE</span>
            )}
            {blockHeight != null && (
              <>
                <span className="rk-statusbar__sep">/</span>
                <span>BLOCK {nf.format(blockHeight)}</span>
              </>
            )}
            <span className="rk-statusbar__right">
              <span>SOURCES {ok}/{total} OK</span>
              {refreshed && (
                <>
                  <span className="rk-statusbar__sep">/</span>
                  <span>REFRESHED {refreshed.toUpperCase()}</span>
                </>
              )}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
