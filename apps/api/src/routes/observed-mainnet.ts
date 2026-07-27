import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  bytecodeHash,
  detectProxyHints,
  getObservedArcClients,
  normalizeAddress,
  probeCode,
  readErc20Meta,
  scanSelectors,
} from "@rugkiller/chain";
import { OBSERVED_ARC_CHAIN, observedArcExplorer } from "@rugkiller/shared";
import { prisma, jparse } from "@rugkiller/db";


type ExplorerToken = {
  address_hash?: string;
  name?: string | null;
  symbol?: string | null;
  decimals?: string | null;
  total_supply?: string | null;
  holders_count?: string | null;
  type?: string | null;
};

type ExplorerAddress = {
  creator_address_hash?: string | null;
  creation_transaction_hash?: string | null;
  is_verified?: boolean;
  is_contract?: boolean;
};

type ExplorerTransaction = {
  hash?: string;
  timestamp?: string;
  from?: { hash?: string };
  to?: { hash?: string };
};

function assessObservedRisk(opts: {
  token: ExplorerToken;
  holders: Array<{ address: string; balance: string }>;
  metadataReliable: boolean;
  verified: boolean;
}) {
  const signals: Array<{ severity: "low" | "medium" | "high" | "critical"; name: string; detail: string }> = [];
  let top1Pct: number | null = null;
  let top5Pct: number | null = null;
  try {
    const supply = BigInt(opts.token.total_supply ?? "0");
    if (supply > 0n && opts.holders.length) {
      const shares = opts.holders.map((holder) => Number((BigInt(holder.balance) * 1_000_000n) / supply) / 10_000);
      top1Pct = shares[0] ?? null;
      top5Pct = shares.slice(0, 5).reduce((sum, value) => sum + value, 0);
      if ((top1Pct ?? 0) >= 50) signals.push({ severity: "critical", name: "Single-holder concentration", detail: `Largest tracked holder controls about ${top1Pct?.toFixed(1)}% of supply.` });
      else if ((top1Pct ?? 0) >= 20) signals.push({ severity: "high", name: "Large single holder", detail: `Largest tracked holder controls about ${top1Pct?.toFixed(1)}% of supply.` });
      if ((top5Pct ?? 0) >= 80) signals.push({ severity: "high", name: "Top-five concentration", detail: `Top five tracked holders control about ${top5Pct?.toFixed(1)}% of supply.` });
    }
  } catch {
    signals.push({ severity: "medium", name: "Supply comparison unavailable", detail: "Holder balances could not be safely compared with total supply." });
  }
  if (!opts.verified) signals.push({ severity: "medium", name: "Code not verified", detail: "The observed explorer does not publish verified source code for this contract." });
  if (!opts.metadataReliable) signals.push({ severity: "medium", name: "Explorer metadata incomplete", detail: "Contract creation metadata is not reliable enough for a complete creator assessment." });
  if (!opts.holders.length) signals.push({ severity: "medium", name: "Holder data unavailable", detail: "Concentration could not be evaluated." });
  else if (Number(opts.token.holders_count ?? opts.holders.length) > opts.holders.length) signals.push({ severity: "medium", name: "Holder list incomplete", detail: `RiskHound assessed ${opts.holders.length} of ${opts.token.holders_count ?? "the known"} holders from the available explorer page.` });
  const order = { low: 0, medium: 1, high: 2, critical: 3 } as const;
  const strongest = signals.reduce<keyof typeof order>((current, signal) => order[signal.severity] > order[current] ? signal.severity : current, "low");
  return {
    level: strongest === "critical" ? "critical_risk" : strongest === "high" ? "high_risk" : strongest === "medium" ? "caution" : "lower_observed_risk",
    confidence: opts.holders.length && opts.metadataReliable ? "medium" : "low",
    top1Pct,
    top5Pct,
    signals,
    limitation: "Read-only observed-network assessment; no buy/sell simulation or source-code audit is claimed.",
  };
}

/**
 * A request must answer even when the node does not. Every call in the read
 * below carries its own deadline, so this is a backstop for anything added
 * outside them; it stays above the per-call budget so a slow call reports its
 * own failure instead of losing the calls that did answer.
 */
const RPC_READ_BUDGET_MS = Number(process.env.OBSERVED_ARC_READ_BUDGET_MS ?? 20_000);
/** Each call gets its own deadline so one slow one cannot eat the whole budget. */
const PER_CALL_BUDGET_MS = Number(process.env.OBSERVED_ARC_CALL_BUDGET_MS ?? 9_000);

function withBudget<T>(work: Promise<T>, fallback: T, ms = RPC_READ_BUDGET_MS): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms).unref?.()),
  ]);
}

/**
 * Read what the node alone can prove about a contract on chain 5042. This is
 * everything the explorer used to supply except the parts that need an index:
 * holder lists, the creator address and source verification.
 */
async function readContractOverRpcUnbounded(address: `0x${string}`) {
  const empty = {
    reachable: false,
    hasCode: false,
    blockNumber: null as string | null,
    bytecodeHash: null as string | null,
    isProxy: false,
    proxyReasons: [] as string[],
    selectors: [] as { selector: string; signature: string }[],
    name: null as string | null,
    symbol: null as string | null,
    decimals: null as number | null,
    totalSupply: null as string | null,
    owner: null as string | null,
    error: null as string | null,
    signals: [] as Array<{ severity: "low" | "medium" | "high" | "critical"; name: string; detail: string }>,
  };

  const { rpc } = getObservedArcClients();
  if (!rpc) return { ...empty, error: "no rpc configured" };

  // None of these three depend on each other, and running them in sequence
  // stacked three round trips against a public endpoint. They also fail
  // independently: a throttled metadata read should not cost us the bytecode
  // we already have, so each carries its own deadline and its own outcome.
  const call = <T>(work: Promise<T>, label: string) =>
    Promise.race([
      work.then((value) => ({ value, error: null as string | null })),
      new Promise<{ value: null; error: string }>((resolve) =>
        setTimeout(() => resolve({ value: null, error: `${label} timed out` }), PER_CALL_BUDGET_MS).unref?.()
      ),
    ]).catch((e) => ({
      value: null,
      error: `${label}: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`,
    }));

  const [codeRes, blockRes, metaRes] = await Promise.all([
    call(probeCode(rpc, address), "getCode"),
    call(rpc.getBlockNumber().then((b) => b.toString()), "getBlockNumber"),
    call(readErc20Meta(rpc, address), "erc20Meta"),
  ]);

  const blockNumber = blockRes.value;
  const meta = metaRes.value;
  const probe = codeRes.value;
  // A silent fall back to cache is undebuggable, so every reason travels back.
  const failures = [codeRes.error, blockRes.error, metaRes.error].filter(Boolean).join("; ");

  if (!probe || !probe.ok) {
    const why = probe && !probe.ok ? probe.error.slice(0, 200) : failures || "getCode returned nothing";
    return { ...empty, blockNumber, error: why };
  }

  const code = probe.code;
  if (!code) {
    // Reporting no bytecode says nothing about the calls that did not answer,
    // and a response claiming a clean read is undebuggable, so they travel too.
    return { ...empty, reachable: true, hasCode: false, blockNumber, error: failures || null };
  }

  const proxy = detectProxyHints(code);
  const selectors = scanSelectors(code);

  const signals: typeof empty.signals = [];
  if (proxy.isProxy) {
    signals.push({
      severity: "high",
      name: "Upgradeable contract",
      detail: `Logic can be replaced after users buy. ${proxy.reasons.join("; ")}`,
    });
  }
  for (const s of selectors) {
    signals.push({
      severity: "medium",
      name: `Privileged function present: ${s.signature}`,
      detail: "Found in deployed bytecode. Whether it is callable and by whom cannot be confirmed without verified source.",
    });
  }
  if (meta?.owner && !/^0x0{40}$/i.test(meta.owner)) {
    signals.push({
      severity: "medium",
      name: "Owner still has control",
      detail: `owner() returns ${meta.owner.toLowerCase()}`,
    });
  }

  return {
    reachable: true,
    hasCode: true,
    blockNumber,
    // Bytecode answered, so the read is usable even if metadata did not.
    error: failures || null,
    bytecodeHash: bytecodeHash(code),
    isProxy: proxy.isProxy,
    proxyReasons: proxy.reasons,
    selectors,
    name: meta?.name ?? null,
    symbol: meta?.symbol ?? null,
    decimals: meta?.decimals ?? null,
    totalSupply: meta?.totalSupply ?? null,
    owner: meta?.owner?.toLowerCase() ?? null,
    signals,
  };
}

type RpcRead = Awaited<ReturnType<typeof readContractOverRpcUnbounded>>;

const UNREACHABLE: RpcRead = {
  reachable: false,
  hasCode: false,
  blockNumber: null,
  bytecodeHash: null,
  isProxy: false,
  proxyReasons: [],
  selectors: [],
  name: null,
  symbol: null,
  decimals: null,
  totalSupply: null,
  owner: null,
  error: "read exceeded its time budget",
  signals: [],
};

function readContractOverRpc(address: `0x${string}`) {
  return withBudget(
    readContractOverRpcUnbounded(address).catch((e) => ({
      ...UNREACHABLE,
      error: (e instanceof Error ? e.message : String(e)).slice(0, 300),
    })),
    UNREACHABLE
  );
}

/**
 * One page view is eight JSON-RPC calls against a keyless public endpoint, and
 * a refresh repeated them all. A read that answered is reused briefly so a
 * crawler cannot throttle the node into reporting a contract as unreadable.
 */
const RPC_READ_TTL_MS = Number(process.env.OBSERVED_ARC_READ_TTL_MS ?? 45_000);
const RPC_READ_CACHE_MAX = 500;
const rpcReadCache = new Map<string, { at: number; value: RpcRead }>();

async function readContractOverRpcCached(address: `0x${string}`): Promise<RpcRead> {
  const key = address.toLowerCase();
  const hit = rpcReadCache.get(key);
  if (hit && Date.now() - hit.at < RPC_READ_TTL_MS) return hit.value;
  const value = await readContractOverRpc(address);
  // A read the node never answered is not cached: pinning an outage in front of
  // the next request would report a readable contract as unreadable for the
  // whole TTL. A read that reached the node is cached even when one of its
  // calls timed out, because the reason travels back in error and is reported
  // as a gap; the alternative is letting a throttled node be re-hammered by
  // every request.
  if (value.reachable) {
    if (rpcReadCache.size >= RPC_READ_CACHE_MAX) {
      // Map iterates in insertion order, so this drops the oldest entry.
      const oldest = rpcReadCache.keys().next().value;
      if (oldest) rpcReadCache.delete(oldest);
    }
    rpcReadCache.set(key, { at: Date.now(), value });
  }
  return value;
}

function decodeExplorerText(value?: string | null) {
  return value
    ?.replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .trim() || null;
}

function tokenView(token: ExplorerToken) {
  const address = token.address_hash?.toLowerCase() ?? "";
  return {
    address,
    name: decodeExplorerText(token.name),
    symbol: decodeExplorerText(token.symbol),
    decimals: token.decimals == null ? null : Number(token.decimals),
    totalSupply: token.total_supply ?? null,
    holderCount: token.holders_count == null ? null : Number(token.holders_count),
    standard: token.type ?? "ERC-20",
    explorerUrl: observedArcExplorer().tokenUrl(address),
  };
}

/**
 * Concentration read from the stored holder index. The thresholds are the ones
 * assessObservedRisk applies to explorer holders, so the two paths agree.
 */
export function concentrationSignals(holders: Array<{ pct: number | null }>) {
  const shares = holders
    .map((holder) => holder.pct)
    .filter((pct): pct is number => pct != null)
    .sort((a, b) => b - a);
  if (!shares.length) return [];
  const top1 = shares[0];
  const top5 = shares.slice(0, 5).reduce((sum, value) => sum + value, 0);
  const signals: Array<{ severity: "low" | "medium" | "high" | "critical"; name: string; detail: string }> = [];
  if (top1 >= 50) {
    signals.push({ severity: "critical", name: "Single-holder concentration", detail: `Largest indexed holder controls about ${top1.toFixed(1)}% of supply.` });
  } else if (top1 >= 20) {
    signals.push({ severity: "high", name: "Large single holder", detail: `Largest indexed holder controls about ${top1.toFixed(1)}% of supply.` });
  }
  if (top5 >= 80) {
    signals.push({ severity: "high", name: "Top-five concentration", detail: `Top five indexed holders control about ${top5.toFixed(1)}% of supply.` });
  }
  return signals;
}

/** Search resolves matching ids with a portable LIKE, so the id set is capped. */
const SEARCH_MATCH_LIMIT = 500;

export async function observedMainnetRoutes(app: FastifyInstance) {
  app.get("/observed-mainnet/tokens", async (request, reply) => {
    const query = z.object({
      page: z.coerce.number().int().min(1).optional().default(1),
      limit: z.coerce.number().int().min(1).max(100).optional().default(50),
      sort: z.enum(["newest", "high_risk", "critical", "holders"]).optional().default("newest"),
      q: z.string().max(120).optional(),
      includeTests: z.enum(["true", "false"]).optional().default("false").transform((value) => value === "true"),
    }).parse(request.query);
    const needle = query.q?.trim().toLowerCase();
    let searchTruncated = false;
    let matchedIds: string[] | null = null;
    if (needle) {
      // Prisma's contains is case sensitive on Postgres and case insensitive on
      // SQLite, and mode: "insensitive" does not exist on the SQLite client, so
      // matching runs against a lowercased form in SQL to behave the same way
      // on both. The cap needs an order, or paging a truncated search would
      // drop and repeat rows between requests.
      const pattern = `%${needle.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
      const matches = await prisma.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Token"
        WHERE "chain" = ${OBSERVED_ARC_CHAIN}
          AND (lower("address") LIKE ${pattern} ESCAPE '\\'
            OR lower("name") LIKE ${pattern} ESCAPE '\\'
            OR lower("symbol") LIKE ${pattern} ESCAPE '\\')
        ORDER BY "createdAt" DESC, "address" ASC
        LIMIT ${SEARCH_MATCH_LIMIT + 1}
      `;
      searchTruncated = matches.length > SEARCH_MATCH_LIMIT;
      matchedIds = matches.slice(0, SEARCH_MATCH_LIMIT).map((row) => row.id);
    }
    const where: Record<string, unknown> = {
      chain: OBSERVED_ARC_CHAIN,
      ...(query.sort === "critical" ? { overallRisk: "critical_risk" } : {}),
      ...(query.sort === "high_risk" ? { overallRisk: { in: ["critical_risk", "high_risk"] } } : {}),
      // NULL LIKE 'qa_%' is NULL, so a plain NOT dropped every token with no
      // name or symbol from both the page and the count. An unnamed contract is
      // exactly what this feed must not hide. The underscore stays unescaped:
      // startsWith is a bound parameter with no ESCAPE clause, so a backslash
      // is literal on SQLite and an escape on Postgres, and the filter would
      // stop excluding anything on the dev datasource.
      ...(!query.includeTests ? {
        AND: [
          { OR: [{ name: null }, { NOT: { name: { startsWith: "qa_" } } }] },
          { OR: [{ symbol: null }, { NOT: { symbol: { startsWith: "qa_" } } }] },
        ],
      } : {}),
      ...(matchedIds ? { id: { in: matchedIds } } : {}),
    };
    const orderBy = query.sort === "holders"
      ? [{ holderCount: "desc" as const }, { createdAt: "desc" as const }]
      : query.sort === "high_risk" || query.sort === "critical"
        // The where clause above narrows overallRisk to critical_risk and
        // high_risk, and "critical_risk" sorts before "high_risk" ascending.
        // Descending put the milder level first, so critical tokens were paged
        // off the first page before the client could reorder them.
        ? [{ overallRisk: "asc" as const }, { holderCount: "desc" as const }]
        : [{ createdAt: "desc" as const }, { address: "asc" as const }];
    const [cached, total] = await Promise.all([
      prisma.token.findMany({ where, orderBy, take: query.limit, skip: (query.page - 1) * query.limit }),
      prisma.token.count({ where }),
    ]);
    return {
      network: { name: "Observed Arc network", chainId: 5042, status: "unannounced" },
      items: cached.map((token) => ({
        address: token.address,
        name: token.name,
        symbol: token.symbol,
        decimals: token.decimals,
        totalSupply: token.totalSupply,
        holderCount: token.holderCount,
        standard: token.standard,
        explorerUrl: observedArcExplorer().tokenUrl(token.address),
        riskAssessment: {
          level: token.overallRisk ?? "caution",
          confidence: token.confidence ?? "low",
          signals: [{ severity: "medium", name: "Open the evidence breakdown", detail: "Token detail contains the currently stored assessment." }],
        },
      })),
      total,
      // A capped search means total counts the matches we could resolve, not
      // every token that matches the term.
      searchTruncated,
      page: query.page,
      pageSize: query.limit,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
      includeTests: query.includeTests,
      explorer: observedArcExplorer().url || null,
      cached: true,
    };
  });

  app.get("/observed-mainnet/tokens/:address", async (request, reply) => {
    const { address } = request.params as { address: string };
    const normalized = normalizeAddress(address);
    if (!normalized) return reply.code(400).send({ error: "invalid_address" });
    // normalizeAddress returns EIP-55 checksummed. Every other writer stores
    // lowercase, so writing the checksummed form created a second Token row
    // for the same contract and the assessment never reached the listing.
    const stored = normalized.toLowerCase();

    const cached = await prisma.token.findUnique({
      where: { chain_address: { chain: OBSERVED_ARC_CHAIN, address: stored } },
      // The holder index reconstructs these from the node, so the detail page
      // has real distribution evidence even with no explorer.
      include: { holders: { orderBy: { pct: "desc" }, take: 50 } },
    });

    const explorer = observedArcExplorer();
    const probe = explorer.configured
      ? await Promise.all([
          fetch(`${explorer.apiV2}/tokens/${stored}`, { signal: AbortSignal.timeout(15_000) }).catch(() => null),
          fetch(`${explorer.apiV2}/tokens/${stored}/holders`, { signal: AbortSignal.timeout(15_000) }).catch(() => null),
          fetch(`${explorer.apiV2}/addresses/${stored}`, { signal: AbortSignal.timeout(15_000) }).catch(() => null),
        ])
      : [null, null, null];
    const [tokenResponse, holdersResponse, addressResponse] = probe;

    // The explorer being unreachable is not the same fact as the token not
    // existing. Serving 404 for an outage told users a real contract was fake.
    // Chain 5042 is still reachable over RPC, so contract facts are read live
    // and only the index-dependent parts are reported as gaps.
    if (!tokenResponse?.ok) {
      const live = await readContractOverRpcCached(normalized);

      if (!live.reachable && !cached) {
        return reply.code(503).send({
          error: "observed_network_unavailable",
          message:
            "Neither the observed Arc explorer nor its RPC answered, and this token is not in the local index.",
          address: stored,
        });
      }
      if (live.reachable && !live.hasCode && !cached) {
        return reply.code(404).send({
          error: "not_a_contract",
          message: "The observed Arc RPC reports no bytecode at this address.",
          address: stored,
        });
      }

      const storedHolders = cached?.holders ?? [];
      // The indexer stores a null pct whenever it had no total supply to divide
      // by, so rows can exist with no share at all. Counting rows alone would
      // drop the gap below and leave the page with neither a concentration
      // signal nor a statement that concentration was never evaluated.
      const concentrationEvaluated = storedHolders.some((holder) => holder.pct != null);
      const creator = cached?.deployer ?? null;
      // The holder index resolves the creator too, so an exact-address bridge
      // link is available here without an explorer.
      const bridgeLinks = creator
        ? await prisma.bridgeTransferRow.findMany({
            where: { OR: [{ recipient: creator }, { sender: creator }] },
            orderBy: { observedAt: "desc" },
            take: 10,
          })
        : [];

      const gaps = [
        {
          severity: "medium" as const,
          name: "No explorer for this network",
          detail:
            "Source verification needs an index. None is available, so verified source code is unknown rather than absent.",
        },
        ...(concentrationEvaluated
          ? []
          : [{
              severity: "medium" as const,
              name: "Holder data unavailable",
              detail: storedHolders.length
                ? "The holder index has balances for this contract but no total supply to express them as shares, so concentration was not evaluated."
                : "The holder index has not reconstructed this contract yet, so concentration was not evaluated.",
            }]),
        ...(creator
          ? []
          : [{
              severity: "medium" as const,
              name: "Creator unknown",
              detail:
                "The deploying account has not been resolved, so creator history was not checked.",
            }]),
        ...(live.reachable
          ? []
          : [{
              severity: "medium" as const,
              name: "Live contract read failed",
              detail: "The RPC did not answer, so the values below come from the last stored record.",
            }]),
      ];

      const signals = [...gaps, ...concentrationSignals(storedHolders), ...live.signals];
      const order = { low: 0, medium: 1, high: 2, critical: 3 } as const;
      const strongest = signals.reduce<keyof typeof order>(
        (current, s) => (order[s.severity] > order[current] ? s.severity : current),
        "low"
      );

      // A read the node answered is thrown away otherwise, so the next request
      // through a throttled endpoint falls back to real values instead of null.
      if (live.hasCode && (live.name || live.symbol || live.decimals != null || live.totalSupply)) {
        await prisma.token
          .upsert({
            where: { chain_address: { chain: OBSERVED_ARC_CHAIN, address: stored } },
            create: {
              chain: OBSERVED_ARC_CHAIN,
              address: stored,
              name: live.name,
              symbol: live.symbol,
              decimals: live.decimals,
              totalSupply: live.totalSupply,
              standard: "ERC-20",
            },
            update: {
              name: live.name ?? cached?.name ?? null,
              symbol: live.symbol ?? cached?.symbol ?? null,
              decimals: live.decimals ?? cached?.decimals ?? null,
              totalSupply: live.totalSupply ?? cached?.totalSupply ?? null,
            },
          })
          .catch(() => undefined);
      }

      return {
        network: { name: "Observed Arc network", chainId: 5042, status: "unannounced" },
        source: live.reachable ? "rpc" : "cache",
        dataGap: {
          source: "observed_arc_explorer",
          reason: explorer.configured ? "explorer_unreachable" : "explorer_not_configured",
          message:
            "This network has no public explorer right now. Contract code and token metadata are read straight from the node and holder distribution comes from RiskHound's own index; source verification is not available at all.",
          rpcBlock: live.blockNumber,
          rpcError: live.error,
        },
        token: {
          address: stored,
          name: live.name ?? cached?.name ?? null,
          symbol: live.symbol ?? cached?.symbol ?? null,
          decimals: live.decimals ?? cached?.decimals ?? null,
          totalSupply: live.totalSupply ?? cached?.totalSupply ?? null,
          holderCount: cached?.holderCount ?? null,
          standard: cached?.standard ?? "ERC-20",
          explorerUrl: explorer.tokenUrl(stored) || null,
        },
        contract: {
          creator,
          creationTxHash: null,
          verified: false,
          verificationKnown: false,
          owner: live.owner,
          isProxy: live.isProxy,
          proxyReasons: live.proxyReasons,
          bytecodeHash: live.bytecodeHash,
          riskySelectors: live.selectors,
          explorerMetadataReliable: false,
        },
        bridgeIntelligence: {
          linked: bridgeLinks.length > 0,
          totalUsdc: bridgeLinks.reduce((sum, row) => sum + row.amountUsdc, 0),
          transfers: bridgeLinks.map((row) => ({
            sourceTxHash: row.sourceTxHash,
            amountUsdc: row.amountUsdc,
            observedAt: row.observedAt.toISOString(),
            sourceExplorerUrl: row.sourceExplorerUrl,
          })),
          limitation: creator
            ? "Exact-address link only. It does not infer common ownership."
            : "The deploying account is not resolved yet, so no link was checked.",
        },
        fundingIntelligence: {
          observedFunder: null,
          linked: false,
          totalUsdc: 0,
          transfers: [],
          confidence: "unavailable",
          limitation: "Tracing the creator's first funder needs a transaction index. None is available.",
        },
        riskAssessment: {
          level:
            strongest === "critical"
              ? "critical_risk"
              : strongest === "high"
                ? "high_risk"
                : "caution",
          confidence: concentrationEvaluated && creator ? "medium" : "low",
          signals,
          limitation:
            "Read from the node without an explorer. Absence of a signal here means it was not checked, not that it is clean.",
        },
        holders: storedHolders.map((holder) => ({
          address: holder.address,
          balance: holder.balance,
          pct: holder.pct,
          labels: jparse<string[]>(holder.labelsJson, []),
        })),
      };
    }
    const token = (await tokenResponse.json()) as ExplorerToken;
    const contract = addressResponse?.ok ? ((await addressResponse.json()) as ExplorerAddress) : null;
    const creator = contract?.creator_address_hash?.toLowerCase() ?? null;
    const bridgeLinks = creator
      ? await prisma.bridgeTransferRow.findMany({
          where: { OR: [{ recipient: creator }, { sender: creator }] },
          orderBy: { observedAt: "desc" },
          take: 10,
        })
      : [];
    let observedFunder: { address: string; txHash: string | null } | null = null;
    if (creator) {
      const creatorTxResponse = await fetch(`${observedArcExplorer().apiV2}/addresses/${creator}/transactions`, { signal: AbortSignal.timeout(12_000) }).catch(() => null);
      if (creatorTxResponse?.ok) {
        const creatorTxs = ((await creatorTxResponse.json()) as { items?: ExplorerTransaction[] }).items ?? [];
        const inbound = [...creatorTxs].reverse().find((tx) =>
          tx.to?.hash?.toLowerCase() === creator && tx.from?.hash && tx.from.hash.toLowerCase() !== creator
        );
        if (inbound?.from?.hash) observedFunder = { address: inbound.from.hash.toLowerCase(), txHash: inbound.hash ?? null };
      }
    }
    const funderBridgeLinks = observedFunder
      ? await prisma.bridgeTransferRow.findMany({
          where: { OR: [{ recipient: observedFunder.address }, { sender: observedFunder.address }] },
          orderBy: { observedAt: "desc" }, take: 10,
        })
      : [];
    const holderBody = holdersResponse?.ok
      ? ((await holdersResponse.json()) as {
          items?: Array<{ address?: { hash?: string } | string; value?: string }>;
        })
      : { items: [] };
    const holders = (holderBody.items ?? []).map((item) => ({
      address: typeof item.address === "string" ? item.address : item.address?.hash ?? "",
      balance: item.value ?? "0",
    }));
    const riskAssessment = assessObservedRisk({
      token,
      holders,
      metadataReliable: contract?.is_contract === true,
      verified: contract?.is_verified === true,
    });
    const view = tokenView(token);
    await prisma.token.upsert({
      where: { chain_address: { chain: OBSERVED_ARC_CHAIN, address: stored } },
      create: {
        chain: OBSERVED_ARC_CHAIN,
        address: stored,
        name: view.name,
        symbol: view.symbol,
        decimals: view.decimals,
        totalSupply: view.totalSupply,
        holderCount: view.holderCount,
        standard: view.standard,
        deployer: creator,
        overallRisk: riskAssessment.level,
        confidence: riskAssessment.confidence,
        rawMeta: JSON.stringify({ source: "observed_arc_explorer", detailAssessedAt: new Date().toISOString() }),
      },
      update: {
        name: view.name,
        symbol: view.symbol,
        decimals: view.decimals,
        totalSupply: view.totalSupply,
        holderCount: view.holderCount,
        standard: view.standard,
        deployer: creator,
        overallRisk: riskAssessment.level,
        confidence: riskAssessment.confidence,
        rawMeta: JSON.stringify({ source: "observed_arc_explorer", detailAssessedAt: new Date().toISOString() }),
      },
    });
    return {
      network: { name: "Observed Arc network", chainId: 5042, status: "unannounced" },
      token: view,
      contract: {
        creator,
        creationTxHash: contract?.creation_transaction_hash ?? null,
        verified: contract?.is_verified ?? false,
        explorerMetadataReliable: contract?.is_contract === true,
      },
      bridgeIntelligence: {
        linked: bridgeLinks.length > 0,
        totalUsdc: bridgeLinks.reduce((sum, row) => sum + row.amountUsdc, 0),
        transfers: bridgeLinks.map((row) => ({
          sourceTxHash: row.sourceTxHash,
          amountUsdc: row.amountUsdc,
          observedAt: row.observedAt.toISOString(),
          sourceExplorerUrl: row.sourceExplorerUrl,
        })),
        limitation: creator
          ? "Exact-address link only. It does not infer common ownership."
          : "Creator metadata is unavailable from the observed explorer.",
      },
      fundingIntelligence: {
        observedFunder,
        linked: funderBridgeLinks.length > 0,
        totalUsdc: funderBridgeLinks.reduce((sum, row) => sum + row.amountUsdc, 0),
        transfers: funderBridgeLinks.map((row) => ({
          sourceTxHash: row.sourceTxHash,
          amountUsdc: row.amountUsdc,
          observedAt: row.observedAt.toISOString(),
          sourceExplorerUrl: row.sourceExplorerUrl,
        })),
        confidence: observedFunder ? "low" : "unavailable",
        limitation: "Uses the earliest inbound transaction in the explorer's available page; it is a lead, not proof of common ownership.",
      },
      riskAssessment,
      holders,
    };
  });
}
