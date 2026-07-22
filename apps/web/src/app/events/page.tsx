import { apiGet } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function EventsPage() {
  const chain = "arc_testnet";
  let items: {
    id: string;
    title: string;
    eventClass: string;
    chain: string;
    confidence: string;
    autoDetected: boolean;
    manualStatus: string;
    tokenAddress?: string | null;
    addresses: string[];
    occurredAt: string;
    detail?: string | null;
    evidence?: { type: string; value: string; url?: string }[];
  }[] = [];
  let err: string | null = null;

  try {
    const data = await apiGet<{ items: typeof items }>(`/events?chain=${chain}&limit=50`);
    items = data.items;
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }

  return (
    <div>
      <h1>Risk events</h1>
      <p className="muted">
        Evidence-based events collected by indexers. Automatic vs manual review are separate fields.
        Failed tokens are not automatically labeled rug pulls.
      </p>
      {err && <div className="card source-bad">{err}</div>}
      <div className="stack">
        {items.map((e) => (
          <article key={e.id} className="card">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h3 style={{ margin: 0 }}>{e.title}</h3>
              <span className="pill">{e.eventClass}</span>
            </div>
            <p className="dim">
              {e.chain} · conf {e.confidence} · auto {String(e.autoDetected)} · manual{" "}
              {e.manualStatus} · {e.occurredAt}
            </p>
            {e.detail && <p>{e.detail}</p>}
            {e.tokenAddress && <p className="mono dim">token {e.tokenAddress}</p>}
            {e.evidence && e.evidence.length > 0 && (
              <ul className="dim">
                {e.evidence.slice(0, 5).map((ev, i) => (
                  <li key={i}>
                    {ev.url ? (
                      <a href={ev.url} target="_blank" rel="noreferrer">
                        {ev.type}: {ev.value}
                      </a>
                    ) : (
                      <span className="mono">
                        {ev.type}: {ev.value}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </article>
        ))}
        {!items.length && !err && <div className="card muted">No events yet. Start the worker.</div>}
      </div>
    </div>
  );
}
