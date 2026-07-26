import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site";

/** Only the stable, linkable surfaces. Per-token pages are excluded on purpose. */
const ROUTES = [
  { path: "/", priority: 1 },
  { path: "/feed", priority: 0.9 },
  { path: "/mainnet", priority: 0.8 },
  { path: "/scan", priority: 0.8 },
  { path: "/wallets", priority: 0.7 },
  { path: "/bridge-watch", priority: 0.7 },
  { path: "/events", priority: 0.6 },
  { path: "/methodology", priority: 0.6 },
  { path: "/api-docs", priority: 0.5 },
  { path: "/appeals", priority: 0.4 },
  { path: "/legal/terms", priority: 0.3 },
];

export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl();
  const now = new Date();
  return ROUTES.map((r) => ({
    url: `${base}${r.path}`,
    lastModified: now,
    changeFrequency: r.priority >= 0.8 ? ("daily" as const) : ("weekly" as const),
    priority: r.priority,
  }));
}
