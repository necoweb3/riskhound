import { apiGet } from "@/lib/api";

type SourceStatus = {
  blockHeight?: number | null;
  tokenCount?: number | null;
  sourcesOk?: number | null;
  sourcesTotal?: number | null;
  refreshedAt?: string | null;
};

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

  const refreshed = ago(data?.refreshedAt);
  const ok = data?.sourcesOk ?? null;
  const total = data?.sourcesTotal ?? null;

  return (
    <div className="rk-statusbar">
      <div className="rk-statusbar__inner">
        {data ? (
          <>
            <span className="rk-statusbar__live">ARC TESTNET · INDEXER LIVE</span>
            {data.blockHeight != null && (
              <>
                <span className="rk-statusbar__sep">/</span>
                <span>BLOCK {nf.format(data.blockHeight)}</span>
              </>
            )}
            {data.tokenCount != null && (
              <>
                <span className="rk-statusbar__sep">/</span>
                <span>{nf.format(data.tokenCount)} CONTRACTS INDEXED</span>
              </>
            )}
            <span className="rk-statusbar__right">
              {ok != null && total != null && <span>SOURCES {ok}/{total} OK</span>}
              {refreshed && (
                <>
                  <span className="rk-statusbar__sep">/</span>
                  <span>REFRESHED {refreshed.toUpperCase()}</span>
                </>
              )}
            </span>
          </>
        ) : (
          <span>ARC TESTNET · INDEXER STATUS UNAVAILABLE</span>
        )}
      </div>
    </div>
  );
}
