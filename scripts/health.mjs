/**
 * Quick health probe for local stack.
 * Usage: node scripts/health.mjs
 */
// Prefer 127.0.0.1 on Windows (avoids some localhost/IPv6 hangups)
const api = process.env.API_PUBLIC_URL ?? "http://127.0.0.1:4000";
const web = process.env.WEB_PUBLIC_URL ?? `http://127.0.0.1:${process.env.WEB_PORT ?? "3001"}`;

async function probe(name, url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const ok = res.ok;
    console.log(`${ok ? "OK " : "BAD"} ${name} ${res.status} ${url}`);
    if (ok && name === "api/health") {
      const body = await res.json();
      console.log("    ", JSON.stringify({ ok: body.ok, db: body.db, service: body.service }));
    }
    return ok;
  } catch (e) {
    console.log(`BAD ${name} ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

const results = await Promise.all([
  probe("api/health", `${api}/health`),
  probe("api/root", `${api}/`),
  probe("web", web),
]);

process.exitCode = results.every(Boolean) ? 0 : 1;
