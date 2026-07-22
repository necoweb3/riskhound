import Link from "next/link";
import { RiskBadge } from "./RiskBadge";
import {
  formatLiquidity,
  friendlySignal,
  shortAddr,
  timeAgo,
  tokenDisplayName,
  type TokenSummary,
} from "@/lib/api";

export function TokenCard({ t }: { t: TokenSummary }) {
  const name = tokenDisplayName({ name: t.name, symbol: t.symbol, address: t.address });
  const checkedWhen = timeAgo(t.analysisUpdatedAt);
  const createdWhen = timeAgo(t.deployTimestamp);
  const liq = formatLiquidity(t.liquidityUsd);

  return (
    <Link href={`/token/${t.address}`} className="rk-card rk-card--link rk-token">
      <div className="rk-token__top">
        <div style={{ minWidth: 0 }}>
          <h3 className="rk-token__name">
            {name}
            {t.symbol && t.name ? (
              <span style={{ color: "var(--text-4)", fontWeight: 500 }}> · {t.symbol}</span>
            ) : null}
          </h3>
          <div className="rk-token__addr">{shortAddr(t.address)}</div>
          <span className="rk-faint" style={{ fontSize: "0.72rem" }}>
            Arc Testnet{!t.name && !t.symbol ? " · metadata unavailable" : ""}
          </span>
        </div>
        <RiskBadge risk={t.overallRisk} />
      </div>

      <div className="rk-token__meta">
        {t.holderCount != null && <span className="rk-chip">{t.holderCount} holders</span>}
        {liq && <span className="rk-chip">{liq}</span>}
      </div>

      {t.topSignals?.length > 0 ? (
        <ul className="rk-token__signals">
          {t.topSignals.slice(0, 2).map((s) => (
            <li key={s}>{friendlySignal(s)}</li>
          ))}
        </ul>
      ) : (
        <p className="rk-faint" style={{ margin: 0, fontSize: "0.875rem" }}>
          {t.overallRisk ? "No major flags in this snapshot" : "Not fully checked yet"}
        </p>
      )}

      <div className="rk-token__foot">
        <span>{t.deployer ? `Creator ${shortAddr(t.deployer)}` : "Creator unknown"}</span>
        <span>
          {createdWhen ? `Created ${createdWhen}` : checkedWhen ? `Checked ${checkedWhen}` : "Not checked yet"}
        </span>
      </div>
    </Link>
  );
}
