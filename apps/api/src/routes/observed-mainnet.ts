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
import { prisma } from "@rugkiller/db";


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
 * Read what the node alone can prove about a contract on chain 5042. This is
 * everything the explorer used to supply except the parts that need an index:
 * holder lists, the creator address and source verification.
 */
/**
 * A request must answer even when the node does not. viem's per-call timeout
 * is not a budget for the whole read, so several slow calls could still add up
 * past the proxy's limit and the request would die with no response at all.
 */
const RPC_READ_BUDGET_MS = Number(process.env.OBSERVED_ARC_READ_BUDGET_MS ?? 8_000);

function withBudget<T>(work: Promise<T>, fallback: T, ms = RPC_READ_BUDGET_MS): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms).unref?.()),
  ]);
}

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

  // A silent fall back to cache is undebuggable, so the reason travels with it.
  const probe = await probeCode(rpc, address);
  if (!probe.ok) return { ...empty, error: probe.error.slice(0, 300) };

  const blockNumber = await rpc.getBlockNumber().then((b) => b.toString()).catch(() => null);
  const code = probe.code;
  if (!code) {
    return { ...empty, reachable: true, hasCode: false, blockNumber };
  }

  const proxy = detectProxyHints(code);
  const selectors = scanSelectors(code);
  const meta = await readErc20Meta(rpc, address).catch(() => null);

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
    error: null,
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

function encodeCursor(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value?: string) {
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function queryString(values: Record<string, unknown> | null) {
  const query = new URLSearchParams({ type: "ERC-20" });
  for (const [key, value] of Object.entries(values ?? {})) {
    query.set(key, value == null ? "null" : String(value));
  }
  return query.toString();
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

function listAssessment(token: ExplorerToken) {
  const signals: Array<{ severity: "medium"; name: string; detail: string }> = [];
  if (!decodeExplorerText(token.name) && !decodeExplorerText(token.symbol)) {
    signals.push({ severity: "medium", name: "Token metadata incomplete", detail: "Name and symbol are unavailable from the observed explorer." });
  }
  if (token.holders_count == null) {
    signals.push({ severity: "medium", name: "Holder list incomplete", detail: "Holder coverage must be checked on the token detail page." });
  }
  signals.push({ severity: "medium", name: "Verification checked in details", detail: "Open the token to load verification and concentration evidence." });
  return { level: "caution", confidence: "low", signals };
}

export async function observedMainnetRoutes(app: FastifyInstance) {
  app.get("/observed-mainnet/tokens", async (request, reply) => {
    const query = z.object({
      page: z.coerce.number().int().min(1).optional().default(1),
      limit: z.coerce.number().int().min(1).max(100).optional().default(50),
      sort: z.enum(["newest", "high_risk", "critical", "holders"]).optional().default("newest"),
      q: z.string().max(120).optional(),
      includeTests: z.enum(["true", "false"]).optional().default("false").transform((value) => value === "true"),
    }).parse(request.query);
    const needle = query.q?.trim();
    const where = {
      chain: OBSERVED_ARC_CHAIN,
      ...(query.sort === "critical" ? { overallRisk: "critical_risk" } : {}),
      ...(query.sort === "high_risk" ? { overallRisk: { in: ["critical_risk", "high_risk"] } } : {}),
      ...(!query.includeTests ? {
        AND: [
          { NOT: { name: { startsWith: "qa_" } } },
          { NOT: { symbol: { startsWith: "qa_" } } },
        ],
      } : {}),
      ...(needle ? { OR: [
        { address: { contains: needle.toLowerCase() } },
        { name: { contains: needle } },
        { symbol: { contains: needle } },
      ] } : {}),
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
      const live = await readContractOverRpc(normalized);

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

      const gaps = [
        {
          severity: "medium" as const,
          name: "No explorer for this network",
          detail:
            "Holder distribution, creator address and source verification need an index. None is available, so they are unknown rather than clear.",
        },
        ...(live.reachable
          ? []
          : [{
              severity: "medium" as const,
              name: "Live contract read failed",
              detail: "The RPC did not answer, so the values below come from the last stored record.",
            }]),
      ];

      const signals = [...gaps, ...live.signals];
      const order = { low: 0, medium: 1, high: 2, critical: 3 } as const;
      const strongest = signals.reduce<keyof typeof order>(
        (current, s) => (order[s.severity] > order[current] ? s.severity : current),
        "low"
      );

      return {
        network: { name: "Observed Arc network", chainId: 5042, status: "unannounced" },
        source: live.reachable ? "rpc" : "cache",
        dataGap: {
          source: "observed_arc_explorer",
          reason: explorer.configured ? "explorer_unreachable" : "explorer_not_configured",
          message:
            "This network has no public explorer right now. Contract code and token metadata are read straight from the node; anything that needs an index is not available.",
          rpcBlock: live.blockNumber,
          rpcError: live.error,
        },
        token: {
          address: stored,
          name: live.name ?? cached?.name ?? null,
          symbol: live.symbol ?? cached?.symbol ?? null,
          decimals: live.decimals ?? cached?.decimals ?? null,
          totalSupply: live.totalSupply ?? cached?.totalSupply ?? null,
          holderCount: null,
          standard: cached?.standard ?? "ERC-20",
          explorerUrl: explorer.tokenUrl(stored) || null,
        },
        contract: {
          creator: cached?.deployer ?? null,
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
        bridgeIntelligence: { linked: false, totalUsdc: 0, transfers: [], limitation: "Requires an explorer index." },
        fundingIntelligence: {
          observedFunder: null,
          linked: false,
          totalUsdc: 0,
          transfers: [],
          confidence: "unavailable",
          limitation: "Requires an explorer index.",
        },
        riskAssessment: {
          level:
            strongest === "critical"
              ? "critical_risk"
              : strongest === "high"
                ? "high_risk"
                : "caution",
          confidence: "low",
          signals,
          limitation:
            "Read from the node without an index. Absence of a holder or creator signal here means it was not checked, not that it is clean.",
        },
        holders: [],
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
