export type PaidFeature =
  | "buy_sell_sim"
  | "funding_graph"
  | "full_report";

export const FEATURE_META: Record<
  PaidFeature,
  { name: string; description: string; envPriceKey: string; defaultPrice: string }
> = {
  buy_sell_sim: {
    name: "Buy/sell simulation",
    description: "Non-custodial simulation of buy and sell paths",
    envPriceKey: "PRICE_BUY_SELL_SIM",
    defaultPrice: "0.10",
  },
  funding_graph: {
    name: "Funding graph",
    description: "Prioritized multi-hop funding and relationship map",
    envPriceKey: "PRICE_FUNDING_GRAPH",
    defaultPrice: "0.20",
  },
  full_report: {
    name: "Full security report",
    description: "All paid analysis modules for one token",
    envPriceKey: "PRICE_FULL_REPORT",
    defaultPrice: "0.50",
  },
};

export function priceFor(feature: PaidFeature, env: NodeJS.ProcessEnv = process.env): string {
  const meta = FEATURE_META[feature];
  return env[meta.envPriceKey] ?? meta.defaultPrice;
}
