import Link from "next/link";
import { apiGet, shortAddr } from "@/lib/api";
import { RiskBadge } from "@/components/RiskBadge";

export const dynamic = "force-dynamic";

type WalletData = {
  address: string;
  chains: Array<{
    chain: string;
    firstSeenAt: string | null;
    lastSeenAt: string | null;
    tokensDeployed: number;
    historyLabel?: string;
  }>;
  fundingSources: Array<{ chain: string; from: string }>;
  deployedTokens: Array<{
    chain: string;
    address: string;
    name: string | null;
    symbol: string | null;
    overallRisk: string | null;
  }>;
  riskEvents: Array<{
    id: string;
    title: string;
    eventClass: string;
    chain: string;
    occurredAt: string;
  }>;
  note?: string;
};

function formatDate(value: string | null) {
  if (!value) return "Not available";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not available";
  return new Intl.DateTimeFormat("en", { year: "numeric", month: "short", day: "numeric" }).format(date);
}

function chainLabel(chain: string) {
  return chain === "arc_observed_5042" ? "Observed Arc 5042" : "Arc Testnet";
}

export default async function WalletPage({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  const { address } = await params;
  const addr = address.toLowerCase();
  let data: WalletData | null = null;
  let error: string | null = null;

  try {
    data = await apiGet(`/wallets/${addr}`);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  if (error || !data) {
    return (
      <div className="rk-stack-lg">
        <h1 className="rk-h1">Creator profile</h1>
        <div className="rk-alert">{error ?? "Not found"}</div>
      </div>
    );
  }

  return (
    <div className="rk-stack-lg">
      <header className="rk-stack">
        <span className="rk-eyebrow">CREATOR INTELLIGENCE</span>
        <h1 className="rk-h1">Creator profile</h1>
        <div className="rk-mono" style={{ overflowWrap: "anywhere" }}>{data.address}</div>
        <p className="rk-faint" style={{ margin: 0 }}>{data.note}</p>
      </header>

      <section className="rk-grid-2">
        {data.chains.map((chain) => (
          <div key={chain.chain} className="rk-card rk-stack">
            <div className="rk-between"><h2 className="rk-h2">{chainLabel(chain.chain)}</h2><span className="rk-chip">{chain.historyLabel ?? "unknown"}</span></div>
            <div className="rk-bridge-list">
              <div className="rk-bridge-row"><span>First seen</span><strong>{formatDate(chain.firstSeenAt)}</strong></div>
              <div className="rk-bridge-row"><span>Last seen</span><strong>{formatDate(chain.lastSeenAt)}</strong></div>
              <div className="rk-bridge-row"><span>Tracked tokens</span><strong>{chain.tokensDeployed}</strong></div>
            </div>
          </div>
        ))}
      </section>

      <section className="rk-card">
        <h2 className="rk-h2">Initial funding</h2>
        {!data.fundingSources.length && <p className="rk-faint">No source identified yet.</p>}
        <ul>
          {data.fundingSources.map((source) => (
            <li key={`${source.chain}:${source.from}`}>
              <Link className="mono" href={`/wallet/${source.from}`}>
                View funder {shortAddr(source.from)}
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="rk-card">
        <h2 className="rk-h2">Tokens created on Arc</h2>
        <div className="rk-table-wrap">
        <table className="rk-table rk-creator-token-table">
          <thead>
            <tr>
              <th>Token</th>
              <th>Risk</th>
            </tr>
          </thead>
          <tbody>
            {data.deployedTokens.map((token) => (
              <tr key={token.address}>
                <td>
                  <Link className="rk-address-link rk-address-link--inline" href={token.chain === "arc_observed_5042" ? `/mainnet/token/${token.address}` : `/token/${token.address}`}>
                    {token.name ?? shortAddr(token.address)} {token.symbol ? `(${token.symbol})` : ""}
                  </Link>
                  <span className="rk-faint" style={{ display: "block", marginTop: 3, fontSize: "0.75rem" }}>{chainLabel(token.chain)}</span>
                </td>
                <td>
                  <RiskBadge risk={token.overallRisk} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        {!data.deployedTokens.length && <p className="rk-faint">No Arc tokens tracked for this creator.</p>}
      </section>

      <section className="rk-card">
        <h2 className="rk-h2">Confirmed prior risk history</h2>
        {data.riskEvents.map((event) => (
          <div key={event.id} className="rk-finding rk-finding--high">
            <strong>{event.title}</strong>
            <div className="rk-faint">
              Evidence source: {event.chain} / {event.eventClass.replace(/_/g, " ")} / {formatDate(event.occurredAt)}
            </div>
          </div>
        ))}
        {!data.riskEvents.length && (
          <p className="rk-faint">No confirmed prior risk event is linked to this address.</p>
        )}
      </section>
    </div>
  );
}
