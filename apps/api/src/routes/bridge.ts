import type { FastifyInstance } from "fastify";
import { prisma } from "@rugkiller/db";
import { observedArcExplorer } from "@rugkiller/shared";

const BASE_TOKEN_MESSENGER = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
const BASE_ARC_ROUTER = "0xb3fa262d0fb521cc93be83d87b322b8a23daf3f0";
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const ARC_USDC = "0x3600000000000000000000000000000000000000";
const ARC_DOMAIN = "26";
const BASE_DOMAIN = 6;
const BASE_BLOCKSCOUT = "https://base.blockscout.com";
const arcObserved = () => observedArcExplorer();
const IRIS_API = "https://iris-api.circle.com";
const CACHE_MS = 5 * 60_000;
const BLOCKSCOUT_PRO_API_KEY = process.env.BLOCKSCOUT_PRO_API_KEY?.trim() || null;
const ARC_MESSAGE_TRANSMITTER = "0x81d40f21f12a8f0e3252bccb954d722d4c464b64";
const ARC_MINT_SELECTOR = "0x40c10f19";
const KNOWN_ARC_MINTERS = new Set([
  "0xeac7420056de0df140758d2e41507922e9d95c26",
  "0x165a04e761b9f28883d2218b5ca3378dba5198d3",
]);
const RECONCILIATION_PROBES = [{
  sourceChain: "base",
  sourceDomain: 6,
  sourceTxHash: "0x636f8271e6702a7879d2158d07adbe984fdfec9da242da3343a8736e5df437ef",
  arcTxHash: "0x17dedd36a1305f60702beec969d14830ef1573b02d609a21e0333dca0acf8ca3",
  amountUsdc: 2,
}];

const CCTP_SOURCES = [
  { key: "ethereum", chainId: 1, domain: 0, explorer: "https://eth.blockscout.com", usdc: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" },
  { key: "optimism", chainId: 10, domain: 2, explorer: "https://optimism.blockscout.com", usdc: "0x0b2c639c533813f4aa9d7837caf62653d097ff85" },
  { key: "arbitrum", chainId: 42161, domain: 3, explorer: "https://arbitrum.blockscout.com", usdc: "0xaf88d065e77c8cc2239327c5edb3a432268e5831" },
  { key: "base", chainId: 8453, domain: 6, explorer: BASE_BLOCKSCOUT, usdc: BASE_USDC },
] as const;

function blockscoutApiUrl(
  chainId: number,
  explorer: string,
  path: string,
  params: Record<string, string> = {}
) {
  const url = BLOCKSCOUT_PRO_API_KEY
    ? new URL(`https://api.blockscout.com/${chainId}/api/v2/${path}`)
    : new URL(`/api/v2/${path}`, explorer);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  if (BLOCKSCOUT_PRO_API_KEY) url.searchParams.set("apikey", BLOCKSCOUT_PRO_API_KEY);
  return url;
}

type DecodedParameter = { name?: string; value?: unknown };
type BaseTransaction = {
  hash?: string;
  timestamp?: string;
  status?: string;
  result?: string;
  method?: string;
  from?: { hash?: string };
  decoded_input?: { parameters?: DecodedParameter[] };
};

type BridgeTransfer = {
  sourceChain: string;
  sourceDomain: number;
  sourceTxHash: string;
  sender: string;
  recipient: string;
  amountUsdc: number;
  observedAt: string;
  status: "waiting_for_circle" | "attestation_ready" | "status_unavailable";
  statusDetail: string;
  sourceExplorerUrl: string;
  recipientArcExplorerUrl: string | null;
  priority: "standard" | "high_value";
};

type ArcTokenBalance = {
  value?: string;
  token?: { address_hash?: string; name?: string | null; symbol?: string | null; decimals?: string | null };
};

type ArcTransaction = {
  hash?: string;
  timestamp?: string;
  method?: string | null;
  from?: { hash?: string };
  to?: { hash?: string; name?: string | null } | null;
  status?: string;
  input?: string;
  raw_input?: string;
};

type ArcUsdcMint = {
  txHash: string;
  block: number | null;
  observedAt: string;
  minter: string;
  recipient: string;
  amountUsdc: number;
  classification: "direct_authorized_mint" | "unrecognized_minter";
  explorerUrl: string | null;
};

type ArcTokenTransfer = {
  transaction_hash?: string;
  timestamp?: string;
  type?: string;
  from?: { hash?: string };
  to?: { hash?: string };
  token?: { address_hash?: string; name?: string | null; symbol?: string | null };
};

/**
 * Every observed-explorer read goes through here. Chain 5042 has no explorer
 * right now, so apiV2 is an empty string, and an empty base produced a
 * relative URL that made fetch throw and took the whole endpoint down with a
 * 500. A missing explorer is a gap in this response, not a failure of it.
 */
async function arcObservedFetch(path: string, timeoutMs: number): Promise<Response | null> {
  const base = arcObserved().apiV2;
  if (!base) return null;
  return fetch(`${base}${path}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => null);
}

/** Null rather than a relative path, so the UI can hide a dead link. */
function arcTxUrl(hash: string) {
  return arcObserved().url ? arcObserved().txUrl(hash) : null;
}
function arcAddressUrl(address: string) {
  return arcObserved().url ? arcObserved().addressUrl(address) : null;
}

async function arcPositions(address: string) {
  if (!/^0x[0-9a-f]{40}$/.test(address)) return [];
  try {
    const response = await arcObservedFetch(`/addresses/${address}/token-balances`, 8_000);
    if (!response?.ok) return [];
    const rows = (await response.json()) as ArcTokenBalance[];
    return rows
      .filter((row) => row.token?.address_hash?.toLowerCase() !== ARC_USDC)
      .filter((row) => {
        try { return BigInt(row.value ?? "0") > 0n; } catch { return false; }
      })
      .slice(0, 8)
      .map((row) => ({
        address: row.token?.address_hash?.toLowerCase() ?? "unknown",
        name: row.token?.name || row.token?.symbol || "Unnamed token",
        symbol: row.token?.symbol || null,
        rawBalance: row.value ?? "0",
        decimals: Number(row.token?.decimals ?? 0),
      }));
  } catch {
    return [];
  }
}

async function arcActivity(address: string) {
  if (!/^0x[0-9a-f]{40}$/.test(address)) return [];
  try {
    const [txResponse, transferResponse] = await Promise.all([
      arcObservedFetch(`/addresses/${address}/transactions`, 8_000),
      arcObservedFetch(`/addresses/${address}/token-transfers`, 8_000),
    ]);
    const txs = txResponse?.ok
      ? ((await txResponse.json()) as { items?: ArcTransaction[] }).items ?? []
      : [];
    const transfers = transferResponse?.ok
      ? ((await transferResponse.json()) as { items?: ArcTokenTransfer[] }).items ?? []
      : [];
    const rows = [
      ...txs.map((tx) => ({
        txHash: tx.hash ?? "",
        occurredAt: tx.timestamp ?? "",
        kind: tx.method ? "contract_call" : "native_transfer",
        label: tx.method || "Native transfer",
        counterparty: tx.to?.hash?.toLowerCase() ?? null,
        tokenAddress: null as string | null,
        tokenSymbol: null as string | null,
        explorerUrl: tx.hash ? arcTxUrl(tx.hash) : null,
      })),
      ...transfers.map((transfer) => ({
        txHash: transfer.transaction_hash ?? "",
        occurredAt: transfer.timestamp ?? "",
        kind: "token_transfer",
        label: transfer.token?.symbol || transfer.token?.name || "Token transfer",
        counterparty:
          transfer.to?.hash?.toLowerCase() === address
            ? transfer.from?.hash?.toLowerCase() ?? null
            : transfer.to?.hash?.toLowerCase() ?? null,
        tokenAddress: transfer.token?.address_hash?.toLowerCase() ?? null,
        tokenSymbol: transfer.token?.symbol || null,
        explorerUrl: transfer.transaction_hash
          ? arcTxUrl(transfer.transaction_hash)
          : null,
      })),
    ];
    return [...new Map(rows.filter((row) => row.txHash).map((row) => [`${row.txHash}:${row.kind}:${row.tokenAddress}`, row])).values()]
      .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
      .slice(0, 12);
  } catch {
    return [];
  }
}

function decodeMintInput(input: string | undefined) {
  if (!input?.toLowerCase().startsWith(ARC_MINT_SELECTOR) || input.length < 138) return null;
  const recipient = `0x${input.slice(34, 74)}`.toLowerCase();
  try {
    const amount = BigInt(`0x${input.slice(74, 138)}`);
    return { recipient, amountUsdc: Number(amount) / 1_000_000 };
  } catch {
    return null;
  }
}

async function arcUsdcIntelligence() {
  try {
    const response = await arcObservedFetch(`/addresses/${ARC_USDC}/transactions?filter=to`, 12_000);
    if (!response?.ok) return { mints: [] as ArcUsdcMint[], totalMintedUsdc: 0 };
    const body = (await response.json()) as { items?: Array<ArcTransaction & { block?: number }> };
    const mints = (body.items ?? []).flatMap((tx): ArcUsdcMint[] => {
      const decoded = decodeMintInput(tx.raw_input ?? tx.input);
      const minter = tx.from?.hash?.toLowerCase() ?? "unknown";
      if (!decoded || !tx.hash || !tx.timestamp || tx.status !== "ok") return [];
      return [{
        txHash: tx.hash,
        block: tx.block ?? null,
        observedAt: tx.timestamp,
        minter,
        recipient: decoded.recipient,
        amountUsdc: decoded.amountUsdc,
        classification: KNOWN_ARC_MINTERS.has(minter) ? "direct_authorized_mint" : "unrecognized_minter",
        explorerUrl: arcTxUrl(tx.hash),
      }];
    });
    return { mints, totalMintedUsdc: mints.reduce((sum, mint) => sum + mint.amountUsdc, 0) };
  } catch {
    return { mints: [] as ArcUsdcMint[], totalMintedUsdc: 0 };
  }
}

async function reconciliationAnomalies() {
  return Promise.all(RECONCILIATION_PROBES.map(async (probe) => {
    const [iris, arc] = await Promise.all([
      fetch(`${IRIS_API}/v2/messages/${probe.sourceDomain}?transactionHash=${probe.sourceTxHash}`, {
        headers: { accept: "application/json" }, signal: AbortSignal.timeout(8_000),
      }).catch(() => null),
      arcObservedFetch(`/transactions/${probe.arcTxHash}`, 8_000).catch(() => null),
    ]);
    const irisBody = iris?.ok ? await iris.json() as { messages?: Array<{ status?: string; attestation?: string | null }> } : null;
    const arcBody = arc?.ok ? await arc.json() as ArcTransaction : null;
    const circleStatus = irisBody?.messages?.[0]?.status ?? "unavailable";
    const arcConfirmed = arcBody?.status === "ok" && arcBody.to?.hash?.toLowerCase() === ARC_MESSAGE_TRANSMITTER;
    return {
      ...probe,
      circleStatus,
      arcConfirmed,
      classification: arcConfirmed && circleStatus !== "complete" ? "iris_pending_arc_confirmed" : arcConfirmed ? "reconciled" : "unresolved",
      detail: arcConfirmed && circleStatus !== "complete"
        ? "Arc receiveMessage succeeded although Circle Iris still reports the source message as pending."
        : arcConfirmed
          ? "Source message and Arc settlement are consistent."
          : "Arc settlement has not been independently confirmed.",
      sourceExplorerUrl: `${BASE_BLOCKSCOUT}/tx/${probe.sourceTxHash}`,
      arcExplorerUrl: arcTxUrl(probe.arcTxHash),
    };
  }));
}

let cache: { expiresAt: number; value: Awaited<ReturnType<typeof loadBridgeWatch>> } | null = null;
/** One refresh fans out around a hundred external calls, so callers share it. */
let inFlight: Promise<Awaited<ReturnType<typeof loadBridgeWatch>>> | null = null;

function parameter(tx: BaseTransaction, name: string): string | null {
  const value = tx.decoded_input?.parameters?.find((item) => item.name === name)?.value;
  return value == null ? null : String(value);
}

function bytes32Address(value: string | null): string | null {
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) return null;
  return `0x${value.slice(-40)}`.toLowerCase();
}

function routerParameter(tx: BaseTransaction, index: number): string | null {
  const value = tx.decoded_input?.parameters?.find((item) => item.name === "bridgeParams")?.value;
  return Array.isArray(value) && value[index] != null ? String(value[index]) : null;
}

async function circleStatus(txHash: string, sourceDomain: number): Promise<Pick<BridgeTransfer, "status" | "statusDetail">> {
  try {
    const response = await fetch(
      `${IRIS_API}/v2/messages/${sourceDomain}?transactionHash=${encodeURIComponent(txHash)}`,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8_000) }
    );
    if (response.status === 404) {
      return {
        status: "waiting_for_circle",
        statusDetail: "Burn observed; Circle has not indexed an attestation yet.",
      };
    }
    if (!response.ok) throw new Error(`Circle returned ${response.status}`);
    const body = (await response.json()) as {
      messages?: Array<{ status?: string; attestation?: string | null }>;
    };
    const message = body.messages?.[0];
    const ready =
      message?.status === "complete" &&
      typeof message.attestation === "string" &&
      message.attestation !== "PENDING";
    if (ready) {
      return {
        status: "attestation_ready",
        statusDetail: "Circle attestation is ready. Arc mint is not claimed until observed onchain.",
      };
    }
    return {
      status: "waiting_for_circle",
      statusDetail:
        message?.status === "pending_confirmations"
          ? "Burn observed; waiting for source-chain confirmations."
          : "Burn observed; Circle attestation is still pending.",
    };
  } catch {
    return {
      status: "status_unavailable",
      statusDetail: "Burn observed; Circle status could not be checked in this refresh.",
    };
  }
}

/**
 * The Arc-side figures were tied to an explorer that no longer exists, but the
 * chain itself still answers. Total USDC supply is a plain totalSupply() call,
 * and a mint is a Transfer out of the zero address, so both are readable from
 * the node without any index at all.
 */
const ARC_RPC = () => process.env.OBSERVED_ARC_RPC_URL ?? "https://5042.rpc.thirdweb.com";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_TOPIC = "0x0000000000000000000000000000000000000000000000000000000000000000";
/** The provider caps a log query at 1000 blocks. */
const ARC_LOG_WINDOW = 1000;
const ARC_MINT_LOOKBACK = Number(process.env.OBSERVED_ARC_MINT_LOOKBACK_BLOCKS ?? 20_000);

async function arcRpc<T>(method: string, params: unknown[], timeoutMs = 8_000): Promise<T | null> {
  try {
    const res = await fetch(ARC_RPC(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: T; error?: unknown };
    return body.error ? null : (body.result ?? null);
  } catch {
    return null;
  }
}

async function arcUsdcSupply(): Promise<number | null> {
  const raw = await arcRpc<string>("eth_call", [{ to: ARC_USDC, data: "0x18160ddd" }, "latest"]);
  if (!raw || raw === "0x") return null;
  try {
    return Number(BigInt(raw)) / 1_000_000;
  } catch {
    return null;
  }
}

/** Recent mints, read as Transfer events whose sender is the zero address. */
async function arcRecentMints() {
  const headHex = await arcRpc<string>("eth_blockNumber", []);
  if (!headHex) return null;
  const head = Number(BigInt(headHex));
  if (!Number.isFinite(head) || head <= 0) return null;
  const from = Math.max(0, head - ARC_MINT_LOOKBACK);

  const mints: { txHash: string; block: number; recipient: string; amountUsdc: number }[] = [];
  for (let start = from; start <= head; start += ARC_LOG_WINDOW) {
    const end = Math.min(start + ARC_LOG_WINDOW - 1, head);
    const logs = await arcRpc<{ topics: string[]; data: string; blockNumber: string; transactionHash: string }[]>(
      "eth_getLogs",
      [{
        address: ARC_USDC,
        topics: [TRANSFER_TOPIC, ZERO_TOPIC],
        fromBlock: `0x${start.toString(16)}`,
        toBlock: `0x${end.toString(16)}`,
      }]
    );
    // A window that failed is not a window with no mints, so stop rather than
    // report a partial scan as the recent total.
    if (logs == null) return null;
    for (const log of logs) {
      if (log.topics.length < 3) continue;
      try {
        mints.push({
          txHash: log.transactionHash,
          block: Number(BigInt(log.blockNumber)),
          recipient: `0x${log.topics[2].slice(26)}`.toLowerCase(),
          amountUsdc: Number(BigInt(log.data === "0x" ? "0x0" : log.data)) / 1_000_000,
        });
      } catch {
        /* a malformed log is skipped, not counted as zero */
      }
    }
  }
  return { mints: mints.slice(-25).reverse(), windowBlocks: head - from, head };
}

async function loadBridgeWatch() {
  const [sourceResults, routerResult, arcUsdcResponse, usdcIntelligence, anomalies, tokenStats, liquidityStats, rpcSupply, rpcMints] = await Promise.all([
    Promise.allSettled(CCTP_SOURCES.map(async (source) => {
      const response = await fetch(blockscoutApiUrl(
        source.chainId,
        source.explorer,
        `addresses/${BASE_TOKEN_MESSENGER}/transactions`,
        { filter: "to" }
      ), {
        headers: { accept: "application/json" }, signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) throw new Error(`${source.key} explorer returned ${response.status}`);
      return { source, body: (await response.json()) as { items?: BaseTransaction[] } };
    })),
    // A router outage is a missing slice of the sample, the same as a failed
    // CCTP source, so it degrades instead of failing the whole endpoint.
    (async () => {
      const response = await fetch(blockscoutApiUrl(
        8453,
        BASE_BLOCKSCOUT,
        `addresses/${BASE_ARC_ROUTER}/transactions`,
        { filter: "to" }
      ), {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) throw new Error(`Base router explorer returned ${response.status}`);
      return (await response.json()) as { items?: BaseTransaction[] };
    })().then(
      (body) => ({ available: true, body }),
      () => ({ available: false, body: {} as { items?: BaseTransaction[] } })
    ),
    arcObservedFetch(`/tokens/${ARC_USDC}`, 12_000),
    arcUsdcIntelligence(),
    reconciliationAnomalies(),
    prisma.token.count({ where: { chain: "arc_observed_5042" } }),
    prisma.token.aggregate({
      where: { chain: "arc_observed_5042", liquidityUsd: { not: null } },
      _count: { liquidityUsd: true }, _sum: { liquidityUsd: true },
    }),
    arcUsdcSupply(),
    arcRecentMints(),
  ]);
  const sourceBodies = sourceResults.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  const routerBody = routerResult.body;
  const arcUsdc = arcUsdcResponse?.ok
    ? ((await arcUsdcResponse.json()) as { total_supply?: string })
    : null;

  const direct = sourceBodies.flatMap(({ source, body }) => (body.items ?? [])
      .filter((tx) => tx.status === "ok" && tx.result === "success")
      .filter((tx) => parameter(tx, "destinationDomain") === ARC_DOMAIN)
      .filter((tx) => parameter(tx, "burnToken")?.toLowerCase() === source.usdc)
      .filter((tx) => Boolean(tx.hash && tx.timestamp))
      .map((tx) => ({
        tx,
        sourceChain: source.key,
        sourceDomain: source.domain,
        sourceExplorer: source.explorer,
        amountRaw: parameter(tx, "amount") ?? "0",
        recipient: bytes32Address(parameter(tx, "mintRecipient")) ?? "unknown",
      })));

  const routed = (routerBody.items ?? [])
    .filter((tx) => tx.status === "ok" && tx.result === "success")
    .filter((tx) => routerParameter(tx, 7) === ARC_DOMAIN)
    .filter((tx) => routerParameter(tx, 5)?.toLowerCase() === BASE_USDC)
    .filter((tx) => Boolean(tx.hash && tx.timestamp))
    .map((tx) => ({
      tx,
      sourceChain: "base" as const,
      sourceDomain: BASE_DOMAIN as 6,
      sourceExplorer: BASE_BLOCKSCOUT as "https://base.blockscout.com",
      amountRaw: routerParameter(tx, 0) ?? "0",
      recipient: bytes32Address(routerParameter(tx, 3)) ?? "unknown",
    }));

  const deduped = new Map<string, (typeof direct)[number]>();
  for (const candidate of [...direct, ...routed]) {
    if (candidate.tx.hash) deduped.set(candidate.tx.hash, candidate);
  }
  const candidates = [...deduped.values()]
    .sort((a, b) => Date.parse(b.tx.timestamp ?? "") - Date.parse(a.tx.timestamp ?? ""))
    .slice(0, 30);

  const transfers: BridgeTransfer[] = await Promise.all(
    candidates.map(async ({ tx, amountRaw, recipient, sourceChain, sourceDomain, sourceExplorer }) => {
      const hash = tx.hash as string;
      const state = await circleStatus(hash, sourceDomain);
      const amountUsdc = Number(amountRaw) / 1_000_000;
      return {
        sourceChain,
        sourceDomain,
        sourceTxHash: hash,
        sender: tx.from?.hash?.toLowerCase() ?? "unknown",
        recipient,
        amountUsdc,
        observedAt: tx.timestamp as string,
        sourceExplorerUrl: `${sourceExplorer}/tx/${hash}`,
        recipientArcExplorerUrl: arcAddressUrl(recipient),
        priority: amountUsdc >= 100 ? "high_value" : "standard",
        ...state,
      };
    })
  );

  await Promise.all(
    transfers.map((transfer) =>
      prisma.bridgeTransferRow.upsert({
        where: { sourceTxHash: transfer.sourceTxHash },
        create: {
          sourceChain: transfer.sourceChain,
          destinationChain: "arc_observed_5042",
          sourceTxHash: transfer.sourceTxHash,
          sender: transfer.sender,
          recipient: transfer.recipient,
          amountUsdc: transfer.amountUsdc,
          status: transfer.status,
          statusDetail: transfer.statusDetail,
          sourceExplorerUrl: transfer.sourceExplorerUrl,
          recipientArcExplorerUrl: transfer.recipientArcExplorerUrl,
          observedAt: new Date(transfer.observedAt),
        },
        update: {
          status: transfer.status,
          statusDetail: transfer.statusDetail,
          recipient: transfer.recipient,
        },
      })
    )
  );

  const [historicalRows, historicalAggregate, statusGroups] = await Promise.all([
    prisma.bridgeTransferRow.count({ where: { destinationChain: "arc_observed_5042" } }),
    prisma.bridgeTransferRow.aggregate({
      where: { destinationChain: "arc_observed_5042" },
      _sum: { amountUsdc: true },
    }),
    prisma.bridgeTransferRow.groupBy({
      by: ["status"], where: { destinationChain: "arc_observed_5042" },
      _count: { _all: true }, _sum: { amountUsdc: true },
    }),
  ]);

  const waiting = transfers.filter((transfer) => transfer.status === "waiting_for_circle");
  const highValueByRecipient = new Map<string, { committedUsdc: number; lastSeenAt: string }>();
  for (const transfer of transfers.filter((item) => item.priority === "high_value")) {
    const existing = highValueByRecipient.get(transfer.recipient);
    highValueByRecipient.set(transfer.recipient, {
      committedUsdc: (existing?.committedUsdc ?? 0) + transfer.amountUsdc,
      lastSeenAt:
        !existing || Date.parse(transfer.observedAt) > Date.parse(existing.lastSeenAt)
          ? transfer.observedAt
          : existing.lastSeenAt,
    });
  }
  const trackedWallets = await Promise.all(
    [...highValueByRecipient.entries()].slice(0, 10).map(async ([address, summary]) => ({
      address,
      ...summary,
      arcExplorerUrl: arcAddressUrl(address),
      ...(await Promise.all([arcPositions(address), arcActivity(address)]).then(([positions, activity]) => ({
        positions,
        activity,
      }))),
    }))
  );
  const mintRecipientTotals = new Map<string, { mintedUsdc: number; lastMintAt: string }>();
  for (const mint of usdcIntelligence.mints) {
    const current = mintRecipientTotals.get(mint.recipient);
    mintRecipientTotals.set(mint.recipient, {
      mintedUsdc: (current?.mintedUsdc ?? 0) + mint.amountUsdc,
      lastMintAt: !current || Date.parse(mint.observedAt) > Date.parse(current.lastMintAt) ? mint.observedAt : current.lastMintAt,
    });
  }
  const systemMintRecipients = await Promise.all(
    [...mintRecipientTotals.entries()]
      .sort((a, b) => b[1].mintedUsdc - a[1].mintedUsdc)
      .slice(0, 10)
      .map(async ([address, summary]) => ({
        address,
        ...summary,
        label: "High-value system mint recipient",
        disclosure: "Receiving an authorized mint is not evidence of wrongdoing.",
        arcExplorerUrl: arcAddressUrl(address),
        ...(await Promise.all([arcPositions(address), arcActivity(address)]).then(([positions, activity]) => ({ positions, activity }))),
      }))
  );
  const explorerSupply = arcUsdc?.total_supply ? Number(arcUsdc.total_supply) / 1_000_000 : null;
  const supplyUsdc = explorerSupply ?? rpcSupply;
  const measuredLiquidityUsd = liquidityStats._sum.liquidityUsd ?? null;
  return {
    network: {
      name: "Observed Arc network",
      chainId: 5042,
      cctpDomain: 26,
      disclosure:
        "Chain 5042 is live and observable, but this feed is not an official Arc mainnet launch announcement.",
    },
    sample: {
      source: "Recent CCTP V2 transactions across accessible source explorers",
      scanned: sourceBodies.reduce((sum, item) => sum + (item.body.items ?? []).length, 0) + (routerBody.items ?? []).length,
      arcTransfers: transfers.length,
      waitingTransfers: waiting.length,
      waitingUsdc: waiting.reduce((sum, transfer) => sum + transfer.amountUsdc, 0),
      limitation: routerResult.available
        ? "This is a recent rolling sample, not the all-time bridge total."
        : "This is a recent rolling sample, not the all-time bridge total. The Base Arc router feed was unreachable in this refresh, so router-initiated transfers are missing from it.",
    },
    indexedHistory: {
      transfers: historicalRows,
      committedUsdc: historicalAggregate._sum.amountUsdc ?? 0,
      startedAt: "local index inception",
      limitation: "Persistent from RiskHound index inception; it is not a reconstruction of all earlier burns.",
      statuses: Object.fromEntries(statusGroups.map((group) => [group.status, {
        transfers: group._count._all,
        usdc: group._sum.amountUsdc ?? 0,
      }])),
    },
    landed: {
      usdc: supplyUsdc,
      source:
        explorerSupply != null
          ? "Observed Arc USDC total supply"
          : rpcSupply != null
            ? "USDC totalSupply() read from the Arc node"
            : "Observed Arc USDC total supply",
      live: supplyUsdc != null,
    },
    transfers,
    trackedWallets,
    supplyIntelligence: {
      // The explorer feed names the minter. The node feed cannot, because the
      // caller is in the transaction and not in the log, so that field stays
      // null rather than being filled with a guess.
      recentDirectMints: usdcIntelligence.mints.length
        ? usdcIntelligence.mints
        : (rpcMints?.mints ?? []).map((m) => ({
            txHash: m.txHash,
            block: m.block,
            observedAt: null,
            minter: null,
            recipient: m.recipient,
            amountUsdc: m.amountUsdc,
            classification: "mint_observed" as const,
            explorerUrl: arcTxUrl(m.txHash),
          })),
      recentDirectMintUsdc: usdcIntelligence.mints.length
        ? usdcIntelligence.totalMintedUsdc
        : (rpcMints?.mints ?? []).reduce((sum, m) => sum + m.amountUsdc, 0),
      mintSource: usdcIntelligence.mints.length
        ? "explorer"
        : rpcMints
          ? "rpc"
          : "unavailable",
      mintWindowBlocks: usdcIntelligence.mints.length ? null : rpcMints?.windowBlocks ?? null,
      knownMinters: [...KNOWN_ARC_MINTERS],
      classificationNote: "Direct authorized mint means the caller has mint authority. It does not prove a CCTP settlement or wrongdoing.",
    },
    reconciliation: {
      anomalies,
      note: "RiskHound compares source burns, Circle status, and Arc settlement independently.",
    },
    liquidityPressure: {
      tokenCount: tokenStats,
      usdcSupply: supplyUsdc,
      usdcPerIndexedToken: supplyUsdc && tokenStats ? supplyUsdc / tokenStats : null,
      measuredDexLiquidityUsd: measuredLiquidityUsd,
      tokensWithMeasuredLiquidity: liquidityStats._count.liquidityUsd,
      coverageComplete: liquidityStats._count.liquidityUsd === tokenStats && tokenStats > 0,
      note: measuredLiquidityUsd == null
        ? "Verified DEX liquidity coverage is not available yet. Total USDC supply is not treated as tradable liquidity."
        : "Only pools stored with a verified liquidity value are included.",
    },
    systemMintRecipients,
    evidence: {
      baseTokenMessenger: BASE_TOKEN_MESSENGER,
      baseArcRouter: BASE_ARC_ROUTER,
      baseArcRouterAvailable: routerResult.available,
      baseExplorer: BASE_BLOCKSCOUT,
      circleAttestationApi: IRIS_API,
      observedArcExplorer: arcObserved().url || null,
      sourceCoverage: [...CCTP_SOURCES.map((source) => ({
        chain: source.key,
        domain: source.domain,
        explorer: source.explorer,
        available: sourceBodies.some((item) => item.source.key === source.key),
        note: null as string | null,
      })), {
        // Solana burns are never queried in this path, so reporting the source
        // as available claimed coverage that does not exist.
        chain: "solana",
        domain: 5,
        explorer: "https://solscan.io",
        available: false,
        note: "Solana CCTP burns are not queried by this feed, so they are a gap rather than a covered source.",
      }],
    },
    refreshedAt: new Date().toISOString(),
  };
}

export async function bridgeRoutes(app: FastifyInstance) {
  app.get("/bridge-watch", async () => {
    if (cache && cache.expiresAt > Date.now()) return cache.value;
    if (!inFlight) {
      inFlight = loadBridgeWatch()
        .then((value) => {
          cache = { value, expiresAt: Date.now() + CACHE_MS };
          return value;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  });
}
