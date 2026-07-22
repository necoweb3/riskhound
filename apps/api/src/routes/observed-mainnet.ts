import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { normalizeAddress } from "@rugkiller/chain";
import { prisma } from "@rugkiller/db";

const EXPLORER = "https://megaeth-pump-ok-moon.poptyedev.com";
const API = `${EXPLORER}/api/v2`;

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
    explorerUrl: `${EXPLORER}/token/${address}`,
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
      cursor: z.string().optional(),
      sort: z.enum(["newest", "high_risk", "critical", "holders"]).optional(),
      q: z.string().max(120).optional(),
    }).parse(request.query);
    if (query.sort || query.q) {
      const needle = query.q?.trim();
      const riskWhere = query.sort === "critical"
        ? { overallRisk: "critical_risk" }
        : query.sort === "high_risk"
          ? { overallRisk: { in: ["critical_risk", "high_risk"] } }
          : {};
      const cached = await prisma.token.findMany({
        where: {
          chain: "arc_observed_5042",
          ...riskWhere,
          ...(needle ? { OR: [
            { address: { contains: needle.toLowerCase() } },
            { name: { contains: needle } },
            { symbol: { contains: needle } },
          ] } : {}),
        },
        orderBy: query.sort === "holders" ? { holderCount: "desc" } : { createdAt: "desc" },
        take: 50,
      });
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
          explorerUrl: `${EXPLORER}/token/${token.address}`,
          riskAssessment: {
            level: token.overallRisk ?? "caution",
            confidence: token.confidence ?? "low",
            signals: [{ severity: "medium", name: "Open the evidence breakdown", detail: "Token detail contains the currently stored assessment." }],
          },
        })),
        nextCursor: null,
        explorer: EXPLORER,
        cached: true,
      };
    }
    const cursor = decodeCursor(query.cursor);
    if (query.cursor && !cursor) return reply.code(400).send({ error: "invalid_cursor" });
    const response = await fetch(`${API}/tokens?${queryString(cursor)}`, {
      headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const cached = await prisma.token.findMany({
        where: { chain: "arc_observed_5042" }, orderBy: { updatedAt: "desc" }, take: 50,
      });
      if (!cached.length) return reply.code(502).send({ error: "mainnet_explorer_unavailable" });
      return {
        network: { name: "Observed Arc network", chainId: 5042, status: "unannounced" },
        items: cached.map((token) => ({
          address: token.address, name: token.name, symbol: token.symbol, decimals: token.decimals,
          totalSupply: token.totalSupply, holderCount: token.holderCount, standard: token.standard,
          explorerUrl: `${EXPLORER}/token/${token.address}`,
          riskAssessment: { level: token.overallRisk ?? "caution", confidence: token.confidence ?? "low", signals: [{ severity: "medium", name: "Cached observed evidence", detail: "Open the token for the latest available breakdown." }] },
        })),
        nextCursor: null,
        explorer: EXPLORER,
        cached: true,
      };
    }
    const body = (await response.json()) as {
      items?: ExplorerToken[];
      next_page_params?: Record<string, unknown> | null;
    };
    const tokenViews = (body.items ?? []).map(tokenView);
    const cachedAssessments = await prisma.token.findMany({
      where: { chain: "arc_observed_5042", address: { in: tokenViews.map((token) => token.address) } },
      select: { address: true, overallRisk: true, confidence: true },
    });
    const assessmentByAddress = new Map(cachedAssessments.map((token) => [token.address, token]));
    return {
      network: { name: "Observed Arc network", chainId: 5042, status: "unannounced" },
      items: (body.items ?? []).map((token) => {
        const view = tokenView(token);
        const cached = assessmentByAddress.get(view.address);
        const fallback = listAssessment(token);
        return {
          ...view,
          riskAssessment: cached?.overallRisk
            ? { ...fallback, level: cached.overallRisk, confidence: cached.confidence ?? fallback.confidence }
            : fallback,
        };
      }),
      nextCursor: body.next_page_params ? encodeCursor(body.next_page_params) : null,
      explorer: EXPLORER,
    };
  });

  app.get("/observed-mainnet/tokens/:address", async (request, reply) => {
    const { address } = request.params as { address: string };
    const normalized = normalizeAddress(address);
    if (!normalized) return reply.code(400).send({ error: "invalid_address" });
    const [tokenResponse, holdersResponse, addressResponse] = await Promise.all([
      fetch(`${API}/tokens/${normalized}`, { signal: AbortSignal.timeout(15_000) }),
      fetch(`${API}/tokens/${normalized}/holders`, { signal: AbortSignal.timeout(15_000) }),
      fetch(`${API}/addresses/${normalized}`, { signal: AbortSignal.timeout(15_000) }),
    ]);
    if (!tokenResponse.ok) return reply.code(404).send({ error: "token_not_found" });
    const token = (await tokenResponse.json()) as ExplorerToken;
    const contract = addressResponse.ok ? ((await addressResponse.json()) as ExplorerAddress) : null;
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
      const creatorTxResponse = await fetch(`${API}/addresses/${creator}/transactions`, { signal: AbortSignal.timeout(12_000) }).catch(() => null);
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
    const holderBody = holdersResponse.ok
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
      where: { chain_address: { chain: "arc_observed_5042", address: normalized } },
      create: {
        chain: "arc_observed_5042",
        address: normalized,
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
