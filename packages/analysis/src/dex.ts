import type { BlockscoutClient, PublicClient } from "@rugkiller/chain";
import type { EvidenceRef, LiquidityPool, SimulationResult } from "@rugkiller/shared";
import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  keccak256,
  padHex,
  parseAbi,
  parseAbiItem,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { DEX_SIMULATOR_RUNTIME } from "./generated/dex-simulator-bytecode.js";

export const APEXISWAP = {
  id: "apexiswap-v2",
  name: "APEXISWAP V2",
  router: "0x437b1aBf6e5a69548849b15EC35f83A73Fa1E28F" as Address,
  factory: "0x2B865487A1008D2694C1D367c761f00a564aCECb" as Address,
  baseToken: "0x911b4000D3422F482F4062a913885f7b035382Df" as Address,
  baseSymbol: "WUSDC",
  baseDecimals: 18,
} as const;

const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";
/**
 * The round trip must run from an address the token has no opinion about.
 * 0x…dEaD is the burn address and is routinely blacklisted, fee-exempted or
 * special-cased, so simulating from it does not describe an ordinary user.
 */
const SIMULATOR = "0x5269736b486f756e6453696d756c61746f720001" as Address;
const MAX_STORAGE_SLOT_PROBE = 32;

const factoryAbi = parseAbi(["function getPair(address,address) view returns (address)"]);
const pairAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)",
]);
const routerAbi = parseAbi(["function getAmountsOut(uint256,address[]) view returns (uint256[])"]);
const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const simulatorAbi = parseAbi([
  "function simulate(address router,address base,address token,uint256 amountIn) returns (uint256 bought,uint256 baseReturned)",
]);
const pairCreated = parseAbiItem(
  "event PairCreated(address indexed token0,address indexed token1,address pair,uint256 pairCount)"
);

type RawRpc = PublicClient & {
  request(args: { method: string; params: unknown[] }): Promise<Hex>;
};

function mappingKey(account: Address, slot: number) {
  return keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [account, BigInt(slot)])
  );
}

async function rawEthCall(client: PublicClient, tx: Record<string, unknown>, overrides?: object) {
  const params: unknown[] = [{ ...tx }, "latest"];
  if (overrides) params.push(overrides);
  return (client as RawRpc).request({ method: "eth_call", params });
}

async function discoverBalanceSlot(client: PublicClient, token: Address) {
  const marker = 0x524b53494dn;
  const markerHex = padHex(toHex(marker), { size: 32 });
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [SIMULATOR] });
  for (let slot = 0; slot <= MAX_STORAGE_SLOT_PROBE; slot++) {
    const key = mappingKey(SIMULATOR, slot);
    try {
      const result = await rawEthCall(client, { to: token, data }, { [token]: { stateDiff: { [key]: markerHex } } });
      const balance = decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: result });
      if (balance === marker) return key;
    } catch {
      // Probe the next standard mapping slot.
    }
  }
  return null;
}

/**
 * A revert proves something about the token. A timeout, a 429 or a dropped
 * socket proves nothing about it at all. Only positive evidence of a revert
 * may become a "cannot sell" verdict, so anything unrecognised is treated as
 * "not tested" rather than as a failed sell.
 */
export function isRevert(error: unknown): boolean {
  const err = error as { code?: unknown; cause?: { code?: unknown }; name?: string };
  // JSON-RPC error 3 is the standard "execution reverted".
  if (err?.code === 3 || err?.cause?.code === 3) return true;
  if (["TimeoutError", "HttpRequestError", "SocketClosedError", "AbortError"].includes(err?.name ?? "")) {
    return false;
  }
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  // Match "network error", never a bare "network": viem puts `URL: <rpcUrl>`
  // in the message of every raw eth_call failure and every Arc endpoint is on
  // the .network TLD, so a bare match classified real reverts as transport and
  // left the honeypot rule unreachable on this chain.
  if (
    /timeout|timed out|fetch failed|econn|socket|network ?error|network request|rate limit|too many requests|\b(429|502|503|504)\b/.test(
      message
    )
  ) {
    return false;
  }
  return /execution reverted|reverted with|invalid opcode|out of gas/.test(message);
}

/**
 * The base token is a compile-time constant, so its balance slot cannot change
 * for a given chain. Re-probing it per analysis costs one sequential eth_call
 * per slot, and a node that refuses state overrides or rate-limits pays all 33
 * on every request. A resolved slot is kept; a failure is only trusted briefly
 * so a passing outage does not disable the round trip for the process lifetime.
 */
const baseSlotCache = new Map<number, { key: Hex | null; at: number }>();
const BASE_SLOT_FAILURE_TTL_MS = 60_000;

async function resolveBaseBalanceSlot(client: PublicClient): Promise<Hex | null> {
  const chainId = client.chain?.id ?? 0;
  const cached = baseSlotCache.get(chainId);
  if (cached && (cached.key != null || Date.now() - cached.at < BASE_SLOT_FAILURE_TTL_MS)) {
    return cached.key;
  }
  const key = await discoverBalanceSlot(client, APEXISWAP.baseToken);
  baseSlotCache.set(chainId, { key, at: Date.now() });
  return key;
}

async function executeRoundTrip(client: PublicClient, token: Address, amountIn: bigint) {
  const slotKey = await resolveBaseBalanceSlot(client);
  if (!slotKey) return { ok: false as const, tested: false, reason: "Base-token balance storage slot could not be resolved safely." };
  const data = encodeFunctionData({
    abi: simulatorAbi,
    functionName: "simulate",
    args: [APEXISWAP.router, APEXISWAP.baseToken, token, amountIn],
  });
  try {
    const result = await rawEthCall(
      client,
      { from: SIMULATOR, to: SIMULATOR, data, gas: "0x1c9c380" },
      {
        [SIMULATOR]: { code: DEX_SIMULATOR_RUNTIME },
        [APEXISWAP.baseToken]: { stateDiff: { [slotKey]: padHex(toHex(amountIn), { size: 32 }) } },
      }
    );
    const [bought, returned] = decodeFunctionResult({
      abi: simulatorAbi,
      functionName: "simulate",
      data: result,
    });
    const lossBps = returned >= amountIn ? 0 : Number(((amountIn - returned) * 10_000n) / amountIn);
    return { ok: true as const, tested: true, bought, returned, lossBps };
  } catch (error) {
    const reverted = isRevert(error);
    return {
      ok: false as const,
      // A transport failure is not a test of the token, so it must not count
      // as one. Only a proven revert is evidence about sellability.
      tested: reverted,
      reverted,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Explorer amounts arrive as strings and are sometimes absent or non-numeric.
 * An unparseable amount is unknown, and a bare BigInt() would throw and take
 * the whole token analysis down with it.
 */
export function toBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return Number.isInteger(value) ? BigInt(value) : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

export async function analyzeApexiSwap(opts: {
  token: Address;
  rpc: PublicClient | null;
  explorer: BlockscoutClient;
  chain: string;
  /**
   * Skip the isolated round trip. Callers that only want the pair and LP data
   * used to run it anyway and throw the answer away.
   */
  skipSimulation?: boolean;
}): Promise<{
  pair: LiquidityPool | null;
  simulation: SimulationResult;
  lpController: string | null;
  lpControllerPct: number | null;
  /** True only when LP supply and LP holder rows were actually read. */
  lpDataComplete: boolean;
  notes: string[];
}> {
  const now = new Date().toISOString();
  if (!opts.rpc) {
    return {
      pair: null,
      lpController: null,
      lpControllerPct: null,
      lpDataComplete: false,
      notes: ["Arc RPC unavailable; verified DEX lookup was not run."],
      simulation: {
        canBuy: null,
        canSell: null,
        buyTaxBps: null,
        sellTaxBps: null,
        steps: [{ step: "Arc RPC", success: false, detail: "RPC unavailable", error: "rpc_unavailable" }],
        summary: "DEX execution test unavailable.",
        simulatedAt: now,
        method: "eth_call",
        dataComplete: false,
      },
    };
  }

  // A factory that did not answer has told us nothing about this token. Folding
  // that failure into the zero address turned a network error into the claim
  // "no verified pair exists".
  const pairLookup = await opts.rpc
    .readContract({
      address: APEXISWAP.factory,
      abi: factoryAbi,
      functionName: "getPair",
      args: [opts.token, APEXISWAP.baseToken],
    })
    .then((value) => ({ ok: true as const, value: value as Address }))
    .catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));

  if (!pairLookup.ok) {
    return {
      pair: null,
      lpController: null,
      lpControllerPct: null,
      lpDataComplete: false,
      notes: ["Verified APEXISWAP factory did not answer; pair existence is unknown."],
      simulation: {
        canBuy: null,
        canSell: null,
        buyTaxBps: null,
        sellTaxBps: null,
        steps: [
          {
            step: "Factory pair lookup",
            success: false,
            detail: "The verified factory call failed, so it is unknown whether a WUSDC pair exists.",
            error: pairLookup.error,
            evidence: [{ type: "contract", chain: opts.chain, value: APEXISWAP.factory }],
          },
        ],
        summary: "Verified factory lookup failed; tradability is unknown.",
        simulatedAt: now,
        method: "eth_call",
        dataComplete: false,
      },
    };
  }

  const pairAddress = pairLookup.value;

  if (pairAddress.toLowerCase() === ZERO) {
    return {
      pair: null,
      lpController: null,
      lpControllerPct: null,
      lpDataComplete: false,
      notes: ["Verified APEXISWAP factory returned no WUSDC pair."],
      simulation: {
        canBuy: null,
        canSell: null,
        buyTaxBps: null,
        sellTaxBps: null,
        steps: [{ step: "Factory pair lookup", success: false, detail: "No WUSDC pair found", evidence: [{ type: "contract", chain: opts.chain, value: APEXISWAP.factory }] }],
        summary: "No verified WUSDC pair; tradability is unknown.",
        simulatedAt: now,
        method: "eth_call",
        dataComplete: false,
      },
    };
  }

  // One unanswered pair read must not discard the rest of the token analysis,
  // so pool state that could not be read is reported as unknown instead.
  const [token0, token1, reserves] = await Promise.all([
    opts.rpc.readContract({ address: pairAddress, abi: pairAbi, functionName: "token0" }).catch(() => null),
    opts.rpc.readContract({ address: pairAddress, abi: pairAbi, functionName: "token1" }).catch(() => null),
    opts.rpc.readContract({ address: pairAddress, abi: pairAbi, functionName: "getReserves" }).catch(() => null),
  ]);

  if (!token0 || !token1 || !reserves) {
    const pairEvidence: EvidenceRef[] = [
      { type: "contract", chain: opts.chain, value: pairAddress, label: APEXISWAP.name },
    ];
    return {
      pair: null,
      lpController: null,
      lpControllerPct: null,
      lpDataComplete: false,
      notes: [
        `Verified ${APEXISWAP.name} WUSDC pair ${pairAddress} was found, but its token and reserve reads did not answer.`,
      ],
      simulation: {
        canBuy: null,
        canSell: null,
        buyTaxBps: null,
        sellTaxBps: null,
        steps: [
          { step: "Verified factory lookup", success: true, detail: `Pair ${pairAddress}`, evidence: pairEvidence },
          {
            step: "Pair state read",
            success: false,
            detail: "Pair token and reserve reads failed, so pool state is unknown.",
            error: "pair_read_failed",
            evidence: pairEvidence,
          },
        ],
        summary: "A verified pair exists, but its state could not be read; tradability is unknown.",
        simulatedAt: now,
        method: "eth_call",
        dataComplete: false,
      },
    };
  }

  const tokenIs0 = token0.toLowerCase() === opts.token.toLowerCase();
  const tokenReserve = tokenIs0 ? reserves[0] : reserves[1];
  const baseReserve = tokenIs0 ? reserves[1] : reserves[0];
  const hasLiquidity = tokenReserve > 0n && baseReserve > 0n;
  const amountIn = 10n ** 16n; // 0.01 WUSDC, 18 decimals
  // A quote that never answered has told us nothing about this token, so it
  // gets the same ok/error shape as the factory lookup rather than collapsing
  // into "no". Otherwise a 429 on a tradable token rendered as "Buy: Failed".
  const buyQuote = hasLiquidity
    ? await opts.rpc
        .readContract({
          address: APEXISWAP.router,
          abi: routerAbi,
          functionName: "getAmountsOut",
          args: [amountIn, [APEXISWAP.baseToken, opts.token]],
        })
        .then((value) => ({ ok: true as const, value }))
        .catch((error: unknown) => ({ ok: false as const, error }))
    : null;
  const buyQuoteReverted = buyQuote != null && !buyQuote.ok && isRevert(buyQuote.error);
  const execution =
    buyQuote?.ok && !opts.skipSimulation
      ? await executeRoundTrip(opts.rpc, opts.token, amountIn)
      : null;

  const [lpToken, lpHolders, lpTransfers] = await Promise.all([
    opts.explorer.getToken(pairAddress).catch(() => null),
    // A failed holder or transfer read is an unknown LP set, not an empty one,
    // so it stays distinguishable from a page that genuinely came back empty.
    opts.explorer.getTokenHolders(pairAddress).catch(() => null),
    opts.explorer.getTokenTransfers(pairAddress).catch(() => null),
  ]);
  const supply = toBigInt(lpToken?.total_supply);
  const holders = (lpHolders?.items ?? []).slice(0, 20).flatMap((holder) => {
    const address = (typeof holder.address === "string" ? holder.address : holder.address.hash).toLowerCase();
    const raw = toBigInt(holder.value);
    // An unreadable balance is unknown, not zero, so the row is left out rather
    // than counted as an empty holder.
    if (raw == null) return [];
    const pct = supply != null && supply > 0n ? Number((raw * 1_000_000n) / supply) / 10_000 : undefined;
    return [{ address, balance: raw.toString(), pct }];
  });
  const lpSupplyKnown = supply != null && supply > 0n;
  const lpHoldersRead = lpHolders != null;
  const lpDataComplete = lpSupplyKnown && lpHoldersRead && holders.length > 0;
  const burnedPct = holders
    .filter((h) => h.address === ZERO || h.address === DEAD)
    .reduce((sum, h) => sum + (h.pct ?? 0), 0);
  const controller = holders.find((h) => h.address !== ZERO && h.address !== DEAD) ?? null;
  const evidence: EvidenceRef[] = [
    { type: "contract", chain: opts.chain, value: pairAddress, label: APEXISWAP.name },
    ...(lpTransfers?.items ?? []).slice(0, 3).map((t) => ({ type: "tx" as const, chain: opts.chain, value: t.transaction_hash })),
  ];
  const pair: LiquidityPool = {
    address: pairAddress.toLowerCase(),
    dex: APEXISWAP.name,
    token0: token0.toLowerCase(),
    token1: token1.toLowerCase(),
    reserve0: reserves[0].toString(),
    reserve1: reserves[1].toString(),
    liquidityUsd: null,
    lpTokenHolders: holders,
    locked: null,
    lockUntil: null,
    // The burned share needs both a readable supply and a holder page that
    // answered. With either missing, "not burned" would be a claim the data
    // does not support.
    burned: lpSupplyKnown && lpHoldersRead ? burnedPct >= 90 : null,
  };

  const executionStep = execution?.ok
    ? {
        step: "Isolated buy → approve → sell",
        success: true,
        detail: `Round trip returned ${formatUnits(execution.returned, APEXISWAP.baseDecimals)} WUSDC (${execution.lossBps} bps loss).`,
        evidence,
      }
    : {
        step: "Isolated buy → approve → sell",
        success: false,
        detail: opts.skipSimulation
          ? "Execution test was not requested for this analysis, so sellability is unproven."
          : execution?.reverted
            ? "Round-trip execution reverted on the sell leg."
            : "Round-trip execution could not be completed, so sellability is unproven.",
        error: execution?.reason,
        evidence,
      };

  return {
    pair,
    lpController: controller?.address ?? null,
    lpControllerPct: controller?.pct ?? null,
    lpDataComplete,
    notes: [
      `Verified ${APEXISWAP.name} WUSDC pair found.`,
      `Base reserve: ${formatUnits(baseReserve, APEXISWAP.baseDecimals)} WUSDC.`,
      !lpSupplyKnown
        ? "LP total supply could not be read, so the burned LP share is unknown."
        : !lpHoldersRead
          ? "The LP holder list did not answer, so the burned LP share is unknown."
          : burnedPct > 0
            ? `Approximately ${burnedPct.toFixed(2)}% of LP supply is burned.`
            : "No burned LP share observed in the returned holder page.",
    ],
    simulation: {
      // Same rule as the sell leg: only a dry pair or a proven revert may make
      // the negative claim. A router that did not answer leaves it unknown.
      canBuy: !hasLiquidity ? false : buyQuote?.ok ? true : buyQuoteReverted ? false : null,
      // A proven revert is the only thing that may say "cannot sell".
      // Collapsing it to null made the honeypot rule in scoring.ts
      // unreachable, so a real sell trap was never reported as one.
      canSell: execution?.ok ? true : execution?.reverted ? false : null,
      buyTaxBps: null,
      sellTaxBps: execution?.ok ? execution.lossBps : null,
      steps: [
        { step: "Verified factory lookup", success: true, detail: `Pair ${pairAddress}`, evidence },
        { step: "Reserve check", success: hasLiquidity, detail: hasLiquidity ? "Both pair reserves are non-zero." : "One or both reserves are zero.", evidence },
        executionStep,
      ],
      summary: execution?.ok
        ? "A buy, approval and complete sell executed in one isolated state-overridden eth_call; no transaction was broadcast."
        : "A verified pair was found, but complete sell execution was not proven.",
      simulatedAt: now,
      method: "eth_call",
      dataComplete: Boolean(execution?.ok),
    },
  };
}

export async function discoverRecentApexiPairs(client: PublicClient, fromBlock: bigint, toBlock: bigint) {
  const found: { token: Address; pair: Address; blockNumber: bigint; transactionHash: Hex }[] = [];
  for (let start = fromBlock; start <= toBlock; start += 5_000n) {
    const end = start + 4_999n > toBlock ? toBlock : start + 4_999n;
    const logs = await client.getLogs({ address: APEXISWAP.factory, event: pairCreated, fromBlock: start, toBlock: end });
    for (const log of logs) {
      const token0 = log.args.token0;
      const token1 = log.args.token1;
      const pair = log.args.pair;
      if (!token0 || !token1 || !pair || !log.transactionHash || log.blockNumber == null) continue;
      const base = APEXISWAP.baseToken.toLowerCase();
      if (token0.toLowerCase() !== base && token1.toLowerCase() !== base) continue;
      found.push({
        token: (token0.toLowerCase() === base ? token1 : token0) as Address,
        pair: pair as Address,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
      });
    }
  }
  return found;
}
