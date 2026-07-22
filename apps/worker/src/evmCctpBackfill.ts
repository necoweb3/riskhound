import { prisma } from "@rugkiller/db";

const MESSENGER = "0x28b5a0e9c621a5badaa536219b3a228c8168cf5d";
const ARC_DOMAIN = "26";
const ARC_EXPLORER = "https://megaeth-pump-ok-moon.poptyedev.com";
const SOURCES = [
  { key: "ethereum", explorer: "https://eth.blockscout.com", usdc: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" },
  { key: "optimism", explorer: "https://optimism.blockscout.com", usdc: "0x0b2c639c533813f4aa9d7837caf62653d097ff85" },
  { key: "arbitrum", explorer: "https://arbitrum.blockscout.com", usdc: "0xaf88d065e77c8cc2239327c5edb3a432268e5831" },
  { key: "base", explorer: "https://base.blockscout.com", usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
] as const;

type Cursor = Record<string, string | number | null>;
type Tx = { hash?: string; timestamp?: string; status?: string; result?: string; from?: { hash?: string }; decoded_input?: { parameters?: Array<{ name?: string; value?: unknown }> } };
function param(tx: Tx, name: string) { const value = tx.decoded_input?.parameters?.find((item) => item.name === name)?.value; return value == null ? null : String(value); }
function recipient(value: string | null) { return /^0x[0-9a-fA-F]{64}$/.test(value ?? "") ? `0x${value!.slice(-40)}`.toLowerCase() : "unknown"; }

async function scanOne(source: typeof SOURCES[number]) {
  const key = `cctp_backfill_${source.key}`;
  const saved = await prisma.indexerCursor.findUnique({ where: { key } });
  const meta = saved?.metaJson ? JSON.parse(saved.metaJson) as { cursor?: Cursor | null; exhausted?: boolean; emptyPages?: number } : {};
  if (meta.exhausted) return { source: source.key, matched: 0, exhausted: true };
  const url = new URL(`/api/v2/addresses/${MESSENGER}/transactions`, source.explorer);
  url.searchParams.set("filter", "to");
  for (const [name, value] of Object.entries(meta.cursor ?? {})) url.searchParams.set(name, value == null ? "null" : String(value));
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`${source.key} returned ${response.status}`);
  const body = await response.json() as { items?: Tx[]; next_page_params?: Cursor | null };
  let matched = 0;
  for (const tx of body.items ?? []) {
    if (tx.status !== "ok" || tx.result !== "success" || param(tx, "destinationDomain") !== ARC_DOMAIN || param(tx, "burnToken")?.toLowerCase() !== source.usdc || !tx.hash || !tx.timestamp) continue;
    const arcRecipient = recipient(param(tx, "mintRecipient"));
    await prisma.bridgeTransferRow.upsert({
      where: { sourceTxHash: tx.hash },
      create: { sourceChain: source.key, destinationChain: "arc_observed_5042", sourceTxHash: tx.hash, sender: tx.from?.hash?.toLowerCase() ?? "unknown", recipient: arcRecipient, amountUsdc: Number(param(tx, "amount") ?? 0) / 1_000_000, status: "waiting_for_circle", statusDetail: "Historical Arc-targeted CCTP V2 burn observed; settlement check pending.", sourceExplorerUrl: `${source.explorer}/tx/${tx.hash}`, recipientArcExplorerUrl: `${ARC_EXPLORER}/address/${arcRecipient}`, observedAt: new Date(tx.timestamp) },
      update: {},
    });
    matched++;
  }
  const emptyPages = matched === 0 ? (meta.emptyPages ?? 0) + 1 : 0;
  const cursor = body.next_page_params ?? null;
  const exhausted = !cursor || emptyPages >= 20;
  await prisma.indexerCursor.upsert({ where: { key }, create: { key, lastAt: new Date(), metaJson: JSON.stringify({ cursor, exhausted, emptyPages }) }, update: { lastAt: new Date(), metaJson: JSON.stringify({ cursor, exhausted, emptyPages }) } });
  return { source: source.key, matched, exhausted };
}

export async function runEvmCctpBackfill() {
  const results = await Promise.allSettled(SOURCES.map(scanOne));
  const failures = results.flatMap((result) => result.status === "rejected" ? [String(result.reason)] : []);
  const healthy = failures.length === 0;
  await prisma.dataSourceHealth.upsert({ where: { key: "evm_cctp_history" }, create: { key: "evm_cctp_history", name: "EVM CCTP history", healthy, lastSuccessAt: healthy ? new Date() : null, lastError: failures.join("; ") || null, metaJson: JSON.stringify(results) }, update: { healthy, ...(healthy ? { lastSuccessAt: new Date() } : {}), lastError: failures.join("; ") || null, metaJson: JSON.stringify(results) } });
}
