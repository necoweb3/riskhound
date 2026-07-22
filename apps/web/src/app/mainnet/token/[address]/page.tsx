import Link from "next/link";
import { apiGet, friendlySignal, riskClass, riskLabel, severityClass, severityLabel, shortAddr } from "@/lib/api";
import { HolderBubbleMap } from "@/components/HolderBubbleMap";

export const dynamic = "force-dynamic";

type MainnetToken = {
  token: {
    address: string;
    name: string | null;
    symbol: string | null;
    decimals: number | null;
    totalSupply: string | null;
    holderCount: number | null;
    explorerUrl: string;
  };
  holders: Array<{ address: string; balance: string }>;
  contract: {
    creator: string | null;
    creationTxHash: string | null;
    verified: boolean;
    explorerMetadataReliable: boolean;
  };
  bridgeIntelligence: {
    linked: boolean;
    totalUsdc: number;
    transfers: Array<{ sourceTxHash: string; amountUsdc: number; observedAt: string; sourceExplorerUrl: string }>;
    limitation: string;
  };
  fundingIntelligence: {
    observedFunder: { address: string; txHash: string | null } | null;
    linked: boolean;
    totalUsdc: number;
    transfers: Array<{ sourceTxHash: string; amountUsdc: number; observedAt: string; sourceExplorerUrl: string }>;
    confidence: string;
    limitation: string;
  };
  riskAssessment: {
    level: string;
    confidence: string;
    top1Pct: number | null;
    top5Pct: number | null;
    signals: Array<{ severity: string; name: string; detail: string }>;
    limitation: string;
  };
};

export default async function MainnetTokenPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  let data: MainnetToken | null = null;
  let error: string | null = null;
  try {
    data = await apiGet<MainnetToken>(`/observed-mainnet/tokens/${address}`);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "Could not load token.";
  }
  if (error || !data) return <div className="rk-alert">{error ?? "Token not found."}</div>;
  const token = data.token;
  const bubbleHolders = data.holders.map((holder) => {
    let pct: number | null = null;
    try {
      const supply = BigInt(token.totalSupply ?? "0");
      if (supply > 0n) pct = Number((BigInt(holder.balance) * 1_000_000n) / supply) / 10_000;
    } catch {
      pct = null;
    }
    return { ...holder, pct, labels: holder.address.toLowerCase() === data.contract.creator?.toLowerCase() ? ["deployer"] : [] };
  });
  return (
    <div className="rk-stack-lg">
      <header>
        <span className="rk-eyebrow">OBSERVED ARC 5042 · READ ONLY</span>
        <h1 className="rk-h1">{token.name || token.symbol || "Unnamed token"}</h1>
        <p className="rk-mono">{token.address}</p>
        <div className="rk-row mt-1">
          <span className={riskClass(data.riskAssessment.level)}>{riskLabel(data.riskAssessment.level)}</span>
          {!data.contract.verified && <span className="rk-chip">Code not verified</span>}
          <span className="rk-chip">{data.riskAssessment.confidence} confidence</span>
        </div>
      </header>
      <section className="rk-grid-3">
          <div className="rk-card"><span className="rk-eyebrow">SYMBOL</span><strong className="rk-metric">{token.symbol || "Unavailable"}</strong></div>
          <div className="rk-card"><span className="rk-eyebrow">HOLDERS</span><strong className="rk-metric">{token.holderCount?.toLocaleString() ?? "Unavailable"}</strong></div>
          <div className="rk-card"><span className="rk-eyebrow">DECIMALS</span><strong className="rk-metric">{token.decimals ?? "Unavailable"}</strong></div>
      </section>
      <section className="rk-card rk-stack">
        <div className="rk-between">
          <div>
            <span className="rk-eyebrow">OBSERVED EVIDENCE</span>
            <h2 className="rk-h2" style={{ marginTop: 6 }}>Risk breakdown</h2>
          </div>
          <span className={riskClass(data.riskAssessment.level)}>{riskLabel(data.riskAssessment.level)}</span>
        </div>
        {data.riskAssessment.signals.length ? data.riskAssessment.signals.map((signal) => (
          <article className={`rk-finding rk-finding--${signal.severity}`} key={`${signal.severity}:${signal.name}`}>
            <div className="rk-between">
              <strong>{friendlySignal(signal.name)}</strong>
              <span className={severityClass(signal.severity)}>{severityLabel(signal.severity)}</span>
            </div>
            <p>{signal.detail}</p>
          </article>
        )) : <p className="rk-faint">No elevated signal was found in the currently available evidence.</p>}
        <p className="rk-faint" style={{ margin: 0 }}>{data.riskAssessment.limitation}</p>
      </section>
      <section className="rk-card rk-stack">
        <div className="rk-between">
          <div>
            <span className="rk-eyebrow">CREATOR INTELLIGENCE</span>
            <h2 className="rk-h2" style={{ marginTop: 6 }}>
              {data.contract.creator ? <Link className="rk-inline-link rk-mono" href={`/wallet/${data.contract.creator}`}>{shortAddr(data.contract.creator)} <span aria-hidden="true">→</span></Link> : "Creator unavailable"}
            </h2>
          </div>
          {data.bridgeIntelligence.linked ? <span className="rk-badge rk-badge--high">Bridge-linked creator</span> : null}
        </div>
        {data.bridgeIntelligence.linked ? (
          <div>
            <strong>{data.bridgeIntelligence.totalUsdc.toLocaleString("en-US")} USDC observed in linked Base → Arc burns</strong>
            <div className="rk-bridge-list" style={{ marginTop: 12 }}>
              {data.bridgeIntelligence.transfers.map((transfer) => (
                <a className="rk-bridge-row" key={transfer.sourceTxHash} href={transfer.sourceExplorerUrl} target="_blank" rel="noreferrer">
                  <span>{transfer.amountUsdc.toLocaleString("en-US")} USDC</span>
                  <span className="rk-mono">{shortAddr(transfer.sourceTxHash)}</span>
                </a>
              ))}
            </div>
          </div>
        ) : <p className="rk-faint">No exact-address bridge link is stored for this creator.</p>}
        <p className="rk-faint" style={{ margin: 0 }}>{data.bridgeIntelligence.limitation}</p>
        {data.fundingIntelligence.linked ? (
          <div className="rk-alert">
            <strong>Creator funding lead</strong>
            <div style={{ marginTop: 6 }}>
              An observed creator funder is linked to {data.fundingIntelligence.totalUsdc.toLocaleString("en-US")} USDC of indexed bridge burns.
            </div>
            <div className="rk-mono" style={{ marginTop: 6 }}>{data.fundingIntelligence.observedFunder?.address}</div>
            <div className="rk-faint" style={{ marginTop: 6 }}>{data.fundingIntelligence.limitation}</div>
          </div>
        ) : null}
      </section>
      <section className="rk-card rk-stack">
        <div className="rk-between">
          <div>
            <h2 className="rk-h2">Holder map</h2>
            <p className="rk-faint" style={{ margin: "0.35rem 0 0" }}>Bubble size is share of supply. Select a bubble to open the wallet.</p>
          </div>
          <span className="rk-chip">{data.holders.length} holders tracked</span>
        </div>
        <HolderBubbleMap holders={bubbleHolders} />
      </section>
      <section className="rk-card">
        <div className="rk-between"><h2 className="rk-h2">Top holders</h2><a className="rk-btn rk-btn--sm" href={token.explorerUrl} target="_blank" rel="noreferrer">Open explorer ↗</a></div>
        <div className="rk-bridge-list">
          {data.holders.slice(0, 20).map((holder) => (
            <div className="rk-bridge-row" key={holder.address}>
              <Link className="rk-inline-link rk-mono" href={`/wallet/${holder.address}`}>{shortAddr(holder.address)}</Link>
              <span className="rk-mono">{holder.balance}</span>
            </div>
          ))}
        </div>
        {!data.holders.length && <p className="rk-faint">Holder data is not available.</p>}
      </section>
      <Link href="/mainnet">← Back to observed tokens</Link>
    </div>
  );
}
