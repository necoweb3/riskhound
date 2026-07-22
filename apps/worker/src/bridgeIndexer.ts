export async function runBridgeIndexer() {
  const api = (process.env.BRIDGE_INDEXER_API_URL ?? "http://localhost:4000").replace(/\/$/, "");
  const response = await fetch(`${api}/bridge-watch`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`Bridge index refresh returned ${response.status}`);
  const body = (await response.json()) as {
    indexedHistory?: { transfers?: number; committedUsdc?: number };
  };
  return body.indexedHistory ?? null;
}
