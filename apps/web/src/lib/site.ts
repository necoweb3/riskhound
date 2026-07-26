/** Canonical origin, no trailing slash. Set WEB_PUBLIC_URL to move it. */
export function siteUrl() {
  return (process.env.WEB_PUBLIC_URL ?? "https://riskhound.xyz").replace(/\/+$/, "");
}
