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

/**
 * One row of the Discover table. Same data as TokenCard, laid out as a dense
 * scannable row instead of a card.
 */
export function TokenRow({ t, hrefBase = "/token" }: { t: TokenSummary; hrefBase?: string }) {
  const name = tokenDisplayName({ name: t.name, symbol: t.symbol, address: t.address });
  const mono = (t.symbol || name).slice(0, 2).toUpperCase();
  const signal = t.topSignals?.length
    ? friendlySignal(t.topSignals[0])
    : t.overallRisk
      ? "No major flags in this snapshot"
      : "Not fully checked yet";
  const when = timeAgo(t.deployTimestamp) ?? timeAgo(t.analysisUpdatedAt);

  return (
    <Link href={`${hrefBase}/${t.address}`} className="rk-tokentable__row rk-reveal rk-reveal--sm">
      <span className="rk-tokentable__id">
        <span className="rk-tokentable__mono" aria-hidden="true">{mono}</span>
        <span style={{ minWidth: 0 }}>
          <span className="rk-tokentable__name">
            {name}
            {t.symbol && t.name ? <em> &middot; {t.symbol}</em> : null}
          </span>
          <span className="rk-tokentable__addr">{shortAddr(t.address)}</span>
        </span>
      </span>

      <RiskBadge risk={t.overallRisk} />

      <span className="rk-tokentable__signal">{signal}</span>
      <span className="rk-tokentable__num">{t.holderCount != null ? t.holderCount.toLocaleString("en-US") : "-"}</span>
      <span className="rk-tokentable__num">{formatLiquidity(t.liquidityUsd) ?? "-"}</span>
      <span className="rk-tokentable__when">{when ?? "-"}</span>
    </Link>
  );
}
