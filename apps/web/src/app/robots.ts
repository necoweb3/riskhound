import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // Reviewer tools and per-address pages are not useful to a crawler:
      // there are thousands of them and they are generated on demand.
      disallow: ["/admin", "/wallet/", "/token/", "/mainnet/token/"],
    },
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
