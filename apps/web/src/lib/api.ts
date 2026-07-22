const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export function getApiUrl() {
  return API_URL;
}

export async function apiGet<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(friendlyError(res.status, body));
  }
  return res.json() as Promise<T>;
}

function friendlyError(status: number, body: string) {
  if (status >= 500) return "Something went wrong. Please try again.";
  if (status === 404) return "Not found.";
  if (status === 429) return "Too many requests. Wait a moment and try again.";
  try {
    const j = JSON.parse(body) as { message?: string; error?: string };
    if (j.message && !j.message.includes("prisma") && !j.message.includes("ECONN")) {
      return j.message;
    }
  } catch {
    /* ignore */
  }
  return "Request failed. Please try again.";
}

export type TokenSummary = {
  id: string;
  chain: string;
  address: string;
  name: string | null;
  symbol: string | null;
  deployer: string | null;
  liquidityUsd: number | null;
  holderCount: number | null;
  overallRisk: string | null;
  confidence: string | null;
  topSignals: string[];
  hasRobinhoodLink: boolean;
  analysisUpdatedAt: string | null;
  deployTimestamp: string | null;
  createdAt: string;
  isVerified?: boolean;
  isProxy?: boolean;
};

/** Short labels for badges */
export function riskLabel(r: string | null | undefined) {
  const map: Record<string, string> = {
    low_detected_risk: "Lower risk",
    caution: "Caution",
    high_risk: "High risk",
    critical_risk: "Critical",
    insufficient_data: "Limited data",
  };
  return r ? map[r] ?? "Unknown" : "Not checked";
}

export function riskClass(r: string | null | undefined) {
  switch (r) {
    case "critical_risk":
      return "rk-badge rk-badge--critical";
    case "high_risk":
      return "rk-badge rk-badge--high";
    case "caution":
      return "rk-badge rk-badge--caution";
    case "low_detected_risk":
      return "rk-badge rk-badge--ok";
    default:
      return "rk-badge rk-badge--muted";
  }
}

export function severityClass(s: string | null | undefined) {
  switch (s) {
    case "critical":
      return "rk-badge rk-badge--critical";
    case "high":
      return "rk-badge rk-badge--high";
    case "medium":
      return "rk-badge rk-badge--caution";
    case "low":
    case "info":
      return "rk-badge rk-badge--ok";
    default:
      return "rk-badge rk-badge--muted";
  }
}

export function severityLabel(s: string | null | undefined) {
  const map: Record<string, string> = {
    critical: "Critical",
    high: "High",
    medium: "Medium",
    low: "Low",
    info: "Info",
  };
  return s ? map[s] ?? s : "";
}

/** Friendly category names */
export function categoryLabel(c: string) {
  const map: Record<string, string> = {
    contract: "Contract",
    owner_admin: "Owner control",
    buy_sell: "Buy & sell",
    liquidity: "Liquidity",
    holder_concentration: "Holders",
    insider_links: "Connected wallets",
    deployer_history: "Deployer history",
    cross_chain: "Other networks",
    market_behavior: "Market activity",
    data_gaps: "Missing info",
  };
  return map[c] ?? c.replace(/_/g, " ");
}

/** Soften technical finding titles for UI */
export function friendlySignal(s: string) {
  return s
    .replace(/Contract source not verified/gi, "Code not verified")
    .replace(/Proxy \/ upgradeable pattern detected/gi, "Upgradeable contract")
    .replace(/Mint authority present/gi, "Can create new tokens")
    .replace(/Blacklist capability/gi, "Can block wallets")
    .replace(/Transfers can be paused/gi, "Transfers can be frozen")
    .replace(/Active owner address/gi, "Owner still has control")
    .replace(/Owner renounced \(zero address\)/gi, "Owner renounced")
    .replace(/Holder data incomplete/gi, "Holder list incomplete")
    .replace(/Liquidity pool data incomplete/gi, "Liquidity unclear")
    .replace(/Buy\/sell simulation incomplete/gi, "Sell check incomplete")
    .replace(/Sell path failed while buy evidence exists/gi, "May be hard to sell")
    .replace(/Limited deployer history/gi, "New or thin deployer history")
    .replace(/Same address active on Robinhood Chain/gi, "Also active on Robinhood Chain")
    .replace(/Address linked to Robinhood risk events/gi, "Linked to past risk events")
    .replace(/High top-10 concentration/gi, "Supply highly concentrated")
    .replace(/Deployer holds large supply share/gi, "Deployer holds a large share")
    .replace(/Same-block multi-recipient acquisition/gi, "Coordinated first buys");
}

export function shortAddr(a: string) {
  if (!a) return "";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function tokenDisplayName(t: {
  name?: string | null;
  symbol?: string | null;
  address?: string | null;
}) {
  if (t.name?.trim()) return t.name.trim();
  if (t.symbol?.trim()) return t.symbol.trim();
  if (t.address) return "Unnamed token";
  return "Unnamed token";
}

export function timeAgo(iso: string | null | undefined) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return "Just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function formatLiquidity(n: number | null | undefined) {
  if (n == null) return null;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${Math.round(n)}`;
}
