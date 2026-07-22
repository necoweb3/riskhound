import { apiGet, shortAddr, timeAgo } from "@/lib/api";

export const dynamic = "force-dynamic";

type Activity = { txHash: string; occurredAt: string; kind: string; label: string; counterparty: string | null; tokenAddress: string | null; tokenSymbol: string | null; explorerUrl: string | null };
type Position = { address: string; name: string; symbol: string | null; rawBalance: string; decimals: number };
type BridgeWatch = {
  network: { name: string; chainId: number; cctpDomain: number; disclosure: string };
  sample: { scanned: number; arcTransfers: number; waitingTransfers: number; waitingUsdc: number; limitation: string };
  indexedHistory: { transfers: number; committedUsdc: number; limitation: string; statuses: Record<string, { transfers: number; usdc: number }> };
  landed: { usdc: number | null; source: string; live: boolean };
  transfers: Array<{ sourceChain: string; sourceTxHash: string; sender: string; recipient: string; amountUsdc: number; observedAt: string; status: "waiting_for_circle" | "attestation_ready" | "status_unavailable"; statusDetail: string; sourceExplorerUrl: string; recipientArcExplorerUrl: string; priority: "standard" | "high_value" }>;
  trackedWallets: Array<{ address: string; committedUsdc: number; lastSeenAt: string; arcExplorerUrl: string; positions: Position[]; activity: Activity[] }>;
  supplyIntelligence: { recentDirectMints: Array<{ txHash: string; observedAt: string; minter: string; recipient: string; amountUsdc: number; classification: string; explorerUrl: string }>; recentDirectMintUsdc: number; classificationNote: string };
  reconciliation: { anomalies: Array<{ sourceTxHash: string; arcTxHash: string; amountUsdc: number; circleStatus: string; arcConfirmed: boolean; classification: string; detail: string; sourceExplorerUrl: string; arcExplorerUrl: string }> };
  liquidityPressure: { tokenCount: number; usdcSupply: number | null; usdcPerIndexedToken: number | null; measuredDexLiquidityUsd: number | null; tokensWithMeasuredLiquidity: number; coverageComplete: boolean; note: string };
  systemMintRecipients: Array<{ address: string; mintedUsdc: number; lastMintAt: string; disclosure: string; arcExplorerUrl: string; positions: Position[]; activity: Activity[] }>;
  refreshedAt: string;
};

const amount = (value: number, digits = 0) => value.toLocaleString("en-US", { maximumFractionDigits: digits });

function statusLabel(status: BridgeWatch["transfers"][number]["status"]) {
  if (status === "attestation_ready") return "Circle ready";
  if (status === "waiting_for_circle") return "Waiting";
  return "Check unavailable";
}

export default async function BridgeWatchPage() {
  let data: BridgeWatch | null = null;
  let error: string | null = null;
  try { data = await apiGet<BridgeWatch>("/bridge-watch"); }
  catch (cause) { error = cause instanceof Error ? cause.message : "Could not load bridge activity."; }

  return <div className="rk-stack-lg rk-bridge-page">
    <header className="rk-bridge-hero">
      <p className="rk-eyebrow">READ-ONLY INTELLIGENCE</p>
      <h1 className="rk-h1">Arc capital watch</h1>
      <p className="rk-lead">Follow USDC supply, source burns, direct mints and large recipients without treating one signal as proof of another.</p>
    </header>

    {error && <div className="rk-alert">{error}</div>}
    {data && <>
      <div className="rk-card rk-bridge-disclosure"><strong>Observed infrastructure, not a launch announcement.</strong><span className="rk-faint">{data.network.disclosure}</span></div>

      <section className="rk-grid-3">
        <div className="rk-card"><span className="rk-eyebrow">USDC ON ARC</span><strong className="rk-metric">{data.landed.usdc == null ? "Unavailable" : amount(data.landed.usdc)}</strong><span className="rk-faint">live observed supply</span></div>
        <div className="rk-card"><span className="rk-eyebrow">INDEXED TOKENS</span><strong className="rk-metric">{amount(data.liquidityPressure.tokenCount)}</strong><span className="rk-faint">observed token contracts</span></div>
        <div className="rk-card"><span className="rk-eyebrow">USDC PER TOKEN</span><strong className="rk-metric">{data.liquidityPressure.usdcPerIndexedToken == null ? "Unavailable" : amount(data.liquidityPressure.usdcPerIndexedToken)}</strong><span className="rk-faint">supply ratio, not liquidity</span></div>
      </section>

      <section className="rk-card rk-stack">
        <div className="rk-between"><div><span className="rk-eyebrow">USDC SUPPLY INTELLIGENCE</span><h2 className="rk-section-title">Recent direct mints</h2></div><strong>{amount(data.supplyIntelligence.recentDirectMintUsdc, 2)} USDC</strong></div>
        <p className="rk-faint rk-zero">{data.supplyIntelligence.classificationNote}</p>
        <div className="rk-table-wrap"><table className="rk-table"><thead><tr><th>Amount</th><th>Recipient</th><th>Minter</th><th>Observed</th><th>Evidence</th></tr></thead><tbody>
          {data.supplyIntelligence.recentDirectMints.map((mint) => <tr key={mint.txHash}>
            <td><strong>{amount(mint.amountUsdc, 2)}</strong> USDC</td>
            <td><a className="rk-evidence-link" href={`/wallet/${mint.recipient}`}>{shortAddr(mint.recipient)}</a></td>
            <td className="rk-mono">{shortAddr(mint.minter)}</td><td>{timeAgo(mint.observedAt)}</td>
            <td><a className="rk-evidence-link" href={mint.explorerUrl} target="_blank" rel="noreferrer">Open transaction</a></td>
          </tr>)}
        </tbody></table></div>
      </section>

      <section className="rk-grid-3">
        <div className="rk-card"><span className="rk-eyebrow">VERIFIED DEX LIQUIDITY</span><strong className="rk-metric">{data.liquidityPressure.measuredDexLiquidityUsd == null ? "Unavailable" : `$${amount(data.liquidityPressure.measuredDexLiquidityUsd)}`}</strong><span className="rk-faint">{data.liquidityPressure.note}</span></div>
        <div className="rk-card"><span className="rk-eyebrow">RECENT WAITING</span><strong className="rk-metric">{amount(data.sample.waitingUsdc, 2)}</strong><span className="rk-faint">USDC in the rolling source sample</span></div>
        <div className="rk-card"><span className="rk-eyebrow">PERSISTENT BURN INDEX</span><strong className="rk-metric">{amount(data.indexedHistory.committedUsdc)}</strong><span className="rk-faint">USDC across {amount(data.indexedHistory.transfers)} stored burns</span></div>
      </section>

      <section className="rk-card rk-stack">
        <div><span className="rk-eyebrow">CCTP RECONCILIATION</span><h2 className="rk-section-title">Source, Circle and Arc compared</h2></div>
        {data.reconciliation.anomalies.map((item) => <article className="rk-reconciliation" key={item.sourceTxHash}>
          <div><strong>{amount(item.amountUsdc, 2)} USDC</strong><p className="rk-faint rk-zero">{item.detail}</p></div>
          <div className="rk-reconciliation__states"><span>Circle <strong>{item.circleStatus.replaceAll("_", " ")}</strong></span><span>Arc <strong>{item.arcConfirmed ? "confirmed" : "unresolved"}</strong></span></div>
          <div className="rk-bridge-row__actions"><a className="rk-btn rk-btn--sm" href={item.sourceExplorerUrl} target="_blank" rel="noreferrer">Source burn</a><a className="rk-btn rk-btn--sm" href={item.arcExplorerUrl} target="_blank" rel="noreferrer">Arc settlement</a></div>
        </article>)}
      </section>

      <section className="rk-card rk-stack">
        <div className="rk-between"><div><span className="rk-eyebrow">LIVE SOURCE EVIDENCE</span><h2 className="rk-section-title">Recent Arc-targeted burns</h2></div><span className="rk-faint">Updated {timeAgo(data.refreshedAt)}</span></div>
        <div className="rk-bridge-list">{data.transfers.map((transfer) => <article className="rk-bridge-row" key={transfer.sourceTxHash}>
          <div><div className="rk-inline"><strong>{amount(transfer.amountUsdc, 2)} USDC</strong><span className={transfer.status === "attestation_ready" ? "rk-badge rk-badge--ok" : "rk-badge rk-badge--caution"}>{statusLabel(transfer.status)}</span>{transfer.priority === "high_value" && <span className="rk-badge rk-badge--high">High value</span>}</div><p className="rk-faint rk-compact">{transfer.statusDetail}</p><span className="rk-mono">{transfer.sourceChain} / {shortAddr(transfer.sender)} to {shortAddr(transfer.recipient)}</span></div>
          <div className="rk-bridge-row__actions"><span className="rk-faint">{timeAgo(transfer.observedAt)}</span><a className="rk-btn rk-btn--sm" href={transfer.sourceExplorerUrl} target="_blank" rel="noreferrer">Burn proof</a><a className="rk-btn rk-btn--sm" href={transfer.recipientArcExplorerUrl} target="_blank" rel="noreferrer">Arc wallet</a></div>
        </article>)}</div>
      </section>

      <section className="rk-card rk-stack">
        <div><span className="rk-eyebrow">SYSTEM MINT RECIPIENTS</span><h2 className="rk-section-title">Large balances under observation</h2><p className="rk-faint rk-zero">Follow-on pool, token and routing activity is monitored. Inclusion is not an accusation.</p></div>
        <div className="rk-bridge-list">{data.systemMintRecipients.map((wallet) => <article className="rk-bridge-row" key={wallet.address}>
          <div><strong>{amount(wallet.mintedUsdc, 2)} USDC minted</strong><div className="rk-mono rk-faint rk-compact">{wallet.address}</div><p className="rk-faint rk-compact">{wallet.disclosure}</p>{wallet.positions.length > 0 && <div className="rk-inline">{wallet.positions.map((position) => <a className="rk-chip" key={position.address} href={`/mainnet/token/${position.address}`}>{position.symbol || position.name}</a>)}</div>}</div>
          <div className="rk-bridge-row__actions"><span className="rk-faint">Last mint {timeAgo(wallet.lastMintAt)}</span><a className="rk-btn rk-btn--sm" href={wallet.arcExplorerUrl} target="_blank" rel="noreferrer">Wallet evidence</a></div>
        </article>)}</div>
      </section>

      <p className="rk-faint rk-zero">{data.sample.limitation} Total USDC supply is not presented as tradable DEX liquidity.</p>
    </>}
  </div>;
}
