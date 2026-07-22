import { prisma } from "@rugkiller/db";

const API = "https://megaeth-pump-ok-moon.poptyedev.com/api/v2";

function query(cursor: Record<string, unknown> | null) {
  const params = new URLSearchParams({ type: "ERC-20" });
  for (const [key, value] of Object.entries(cursor ?? {})) params.set(key, value == null ? "null" : String(value));
  return params.toString();
}

export async function runObservedMainnetIndexer() {
  let cursor: Record<string, unknown> | null = null;
  let pages = 0;
  let indexed = 0;
  do {
    const response = await fetch(`${API}/tokens?${query(cursor)}`, {
      headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Observed Arc explorer returned ${response.status}`);
    const body = (await response.json()) as {
      items?: Array<{ address_hash?: string; name?: string | null; symbol?: string | null; decimals?: string | null; total_supply?: string | null; holders_count?: string | null; type?: string | null }>;
      next_page_params?: Record<string, unknown> | null;
    };
    for (const item of body.items ?? []) {
      const address = item.address_hash?.toLowerCase();
      if (!address) continue;
      await prisma.token.upsert({
        where: { chain_address: { chain: "arc_observed_5042", address } },
        create: {
          chain: "arc_observed_5042", address, name: item.name ?? null, symbol: item.symbol ?? null,
          decimals: item.decimals == null ? null : Number(item.decimals), totalSupply: item.total_supply ?? null,
          holderCount: item.holders_count == null ? null : Number(item.holders_count), standard: item.type ?? "ERC-20",
          rawMeta: JSON.stringify({ source: "observed_arc_explorer" }),
        },
        update: {
          name: item.name ?? undefined, symbol: item.symbol ?? undefined,
          decimals: item.decimals == null ? undefined : Number(item.decimals), totalSupply: item.total_supply ?? undefined,
          holderCount: item.holders_count == null ? undefined : Number(item.holders_count), standard: item.type ?? undefined,
          rawMeta: JSON.stringify({ source: "observed_arc_explorer", refreshedAt: new Date().toISOString() }),
        },
      });
      indexed++;
    }
    cursor = body.next_page_params ?? null;
    pages++;
  } while (cursor && pages < 100);

  await prisma.dataSourceHealth.upsert({
    where: { key: "arc_observed_5042_tokens" },
    create: { key: "arc_observed_5042_tokens", name: "Observed Arc 5042 token inventory", healthy: true, lastSuccessAt: new Date(), metaJson: JSON.stringify({ indexed, pages }) },
    update: { healthy: true, lastSuccessAt: new Date(), lastError: null, metaJson: JSON.stringify({ indexed, pages }) },
  });
  return { indexed, pages };
}
