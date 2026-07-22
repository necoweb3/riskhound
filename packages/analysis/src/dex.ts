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
const SIMULATOR = "0x000000000000000000000000000000000000dEaD" as Address;
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

async function executeRoundTrip(client: PublicClient, token: Address, amountIn: bigint) {
  const slotKey = await discoverBalanceSlot(client, APEXISWAP.baseToken);
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
    return {
      ok: false as const,
      tested: true,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function analyzeApexiSwap(opts: {
  token: Address;
  tokenDecimals: number | null;
  rpc: PublicClient | null;
  explorer: BlockscoutClient;
  chain: string;
}): Promise<{
  pair: LiquidityPool | null;
  simulation: SimulationResult;
  lpController: string | null;
  lpControllerPct: number | null;
  notes: string[];
}> {
  const now = new Date().toISOString();
  if (!opts.rpc) {
    return {
      pair: null,
      lpController: null,
      lpControllerPct: null,
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

  const pairAddress = (await opts.rpc.readContract({
    address: APEXISWAP.factory,
    abi: factoryAbi,
    functionName: "getPair",
    args: [opts.token, APEXISWAP.baseToken],
  }).catch(() => ZERO)) as Address;

  if (pairAddress.toLowerCase() === ZERO) {
    return {
      pair: null,
      lpController: null,
      lpControllerPct: null,
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

  const [token0, token1, reserves] = await Promise.all([
    opts.rpc.readContract({ address: pairAddress, abi: pairAbi, functionName: "token0" }),
    opts.rpc.readContract({ address: pairAddress, abi: pairAbi, functionName: "token1" }),
    opts.rpc.readContract({ address: pairAddress, abi: pairAbi, functionName: "getReserves" }),
  ]);
  const tokenIs0 = token0.toLowerCase() === opts.token.toLowerCase();
  const tokenReserve = tokenIs0 ? reserves[0] : reserves[1];
  const baseReserve = tokenIs0 ? reserves[1] : reserves[0];
  const hasLiquidity = tokenReserve > 0n && baseReserve > 0n;
  const amountIn = 10n ** 16n; // 0.01 WUSDC, 18 decimals
  const buyQuote = hasLiquidity
    ? await opts.rpc.readContract({
        address: APEXISWAP.router,
        abi: routerAbi,
        functionName: "getAmountsOut",
        args: [amountIn, [APEXISWAP.baseToken, opts.token]],
      }).catch(() => null)
    : null;
  const execution = buyQuote ? await executeRoundTrip(opts.rpc, opts.token, amountIn) : null;

  const [lpToken, lpHolders, lpTransfers] = await Promise.all([
    opts.explorer.getToken(pairAddress).catch(() => null),
    opts.explorer.getTokenHolders(pairAddress).catch(() => ({ items: [] })),
    opts.explorer.getTokenTransfers(pairAddress).catch(() => ({ items: [] })),
  ]);
  const supply = BigInt(lpToken?.total_supply ?? "0");
  const holders = (lpHolders.items ?? []).slice(0, 20).map((holder) => {
    const address = (typeof holder.address === "string" ? holder.address : holder.address.hash).toLowerCase();
    const raw = BigInt(holder.value ?? "0");
    const pct = supply > 0n ? Number((raw * 1_000_000n) / supply) / 10_000 : undefined;
    return { address, balance: raw.toString(), pct };
  });
  const burnedPct = holders
    .filter((h) => h.address === ZERO || h.address === DEAD)
    .reduce((sum, h) => sum + (h.pct ?? 0), 0);
  const controller = holders.find((h) => h.address !== ZERO && h.address !== DEAD) ?? null;
  const evidence: EvidenceRef[] = [
    { type: "contract", chain: opts.chain, value: pairAddress, label: APEXISWAP.name },
    ...(lpTransfers.items ?? []).slice(0, 3).map((t) => ({ type: "tx" as const, chain: opts.chain, value: t.transaction_hash })),
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
    burned: burnedPct >= 90,
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
        detail: execution?.tested ? "Round-trip execution reverted." : "Round-trip execution unsupported by RPC/state layout.",
        error: execution?.reason,
        evidence,
      };

  return {
    pair,
    lpController: controller?.address ?? null,
    lpControllerPct: controller?.pct ?? null,
    notes: [
      `Verified ${APEXISWAP.name} WUSDC pair found.`,
      `Base reserve: ${formatUnits(baseReserve, APEXISWAP.baseDecimals)} WUSDC.`,
      burnedPct > 0 ? `Approximately ${burnedPct.toFixed(2)}% of LP supply is burned.` : "No burned LP share observed in the returned holder page.",
    ],
    simulation: {
      canBuy: Boolean(buyQuote),
      canSell: execution?.ok ? true : null,
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
