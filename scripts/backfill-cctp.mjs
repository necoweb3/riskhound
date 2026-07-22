import { createRequire } from "node:module";

const require = createRequire(new URL("../packages/db/package.json", import.meta.url));
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const messenger = "0x28b5a0e9c621a5badaa536219b3a228c8168cf5d";
const arcDomain = "26";
const maxPages = Number(process.env.CCTP_BACKFILL_MAX_PAGES ?? 50);
const sources = [
  { key: "ethereum", explorer: "https://eth.blockscout.com", usdc: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" },
  { key: "optimism", explorer: "https://optimism.blockscout.com", usdc: "0x0b2c639c533813f4aa9d7837caf62653d097ff85" },
  { key: "arbitrum", explorer: "https://arbitrum.blockscout.com", usdc: "0xaf88d065e77c8cc2239327c5edb3a432268e5831" },
  { key: "base", explorer: "https://base.blockscout.com", usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
];

function param(tx, name) {
  const value = tx.decoded_input?.parameters?.find((item) => item.name === name)?.value;
  return value == null ? null : String(value);
}

function recipient(value) {
  return /^0x[0-9a-fA-F]{64}$/.test(value ?? "") ? `0x${value.slice(-40)}`.toLowerCase() : "unknown";
}

function nextUrl(source, cursor) {
  const url = new URL(`/api/v2/addresses/${messenger}/transactions`, source.explorer);
  url.searchParams.set("filter", "to");
  for (const [key, value] of Object.entries(cursor ?? {})) url.searchParams.set(key, value == null ? "null" : String(value));
  return url;
}

async function scan(source) {
  const cursorKey = `cctp_backfill_${source.key}`;
  const saved = await prisma.indexerCursor.findUnique({ where: { key: cursorKey } });
  let cursor = saved?.metaJson ? JSON.parse(saved.metaJson).cursor ?? null : null;
  let pages = 0;
  let matched = 0;
  let emptyPages = 0;
  do {
    const response = await fetch(nextUrl(source, cursor), { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`${source.key} returned ${response.status}`);
    const body = await response.json();
    let pageMatched = 0;
    for (const tx of body.items ?? []) {
      if (tx.status !== "ok" || tx.result !== "success") continue;
      if (param(tx, "destinationDomain") !== arcDomain) continue;
      if (param(tx, "burnToken")?.toLowerCase() !== source.usdc) continue;
      if (!tx.hash || !tx.timestamp) continue;
      const amountUsdc = Number(param(tx, "amount") ?? 0) / 1_000_000;
      const arcRecipient = recipient(param(tx, "mintRecipient"));
      await prisma.bridgeTransferRow.upsert({
        where: { sourceTxHash: tx.hash },
        create: {
          sourceChain: source.key,
          destinationChain: "arc_observed_5042",
          sourceTxHash: tx.hash,
          sender: tx.from?.hash?.toLowerCase() ?? "unknown",
          recipient: arcRecipient,
          amountUsdc,
          status: "waiting_for_circle",
          statusDetail: "Historical Arc-targeted CCTP V2 burn observed; settlement check pending.",
          sourceExplorerUrl: `${source.explorer}/tx/${tx.hash}`,
          recipientArcExplorerUrl: `https://megaeth-pump-ok-moon.poptyedev.com/address/${arcRecipient}`,
          observedAt: new Date(tx.timestamp),
        },
        update: {},
      });
      matched++;
      pageMatched++;
    }
    emptyPages = pageMatched === 0 ? emptyPages + 1 : 0;
    cursor = body.next_page_params ?? null;
    pages++;
    await prisma.indexerCursor.upsert({
      where: { key: cursorKey },
      create: { key: cursorKey, lastAt: new Date(), metaJson: JSON.stringify({ cursor, exhausted: !cursor }) },
      update: { lastAt: new Date(), metaJson: JSON.stringify({ cursor, exhausted: !cursor }) },
    });
  } while (cursor && pages < maxPages && emptyPages < 20);
  return { source: source.key, pages, matched, exhausted: !cursor };
}

try {
  const results = await Promise.all(sources.map(scan));
  const aggregate = await prisma.bridgeTransferRow.aggregate({
    where: { destinationChain: "arc_observed_5042" },
    _count: true,
    _sum: { amountUsdc: true },
  });
  console.log(JSON.stringify({ results, indexed: aggregate._count, committedUsdc: aggregate._sum.amountUsdc ?? 0 }, null, 2));
} finally {
  await prisma.$disconnect();
}
