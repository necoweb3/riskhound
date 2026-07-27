import {
  createPublicClient,
  fallback,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type Chain,
  getAddress,
  isAddress,
  keccak256,
  toFunctionSelector,
} from "viem";
import type { NetworkConfig } from "@rugkiller/shared";

export type { PublicClient, Address, Hex };

const ERC20_ABI = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "getOwner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
] as const;

/**
 * Privileged, state-changing functions worth reporting when the dispatcher
 * pushes their selector.
 *
 * The table is derived from the signatures at load rather than written as
 * literal selectors: several hand-written pairs hashed to a different function
 * than the label they carried, so the product named a privileged function it
 * had not found and the selector in the evidence ref did not check out against
 * the signature beside it. Anything that cannot be derived here does not
 * belong here.
 */
const PRIVILEGED_SIGNATURES = [
  // mint / supply
  "mint(address,uint256)",
  "mint(uint256)",
  "mintTo(address,uint256)",
  // pause / blacklist
  "pause()",
  "unpause()",
  "blacklist(address)",
  "addBlackList(address)",
  "removeBlackList(address)",
  "addToBlacklist(address)",
  "setBlacklistEnabled(bool)",
  // trading / max
  "transferOwnership(address)",
  "setMaxTxAmount(uint256)",
  "setMaxTxPercent(uint256)",
  "setSellFee(uint256)",
  "setSwapAndLiquifyEnabled(bool)",
  // taxes
  "setTaxFee(uint256)",
  "setTaxFeePercent(uint256)",
  "setLiquidityFee(uint256)",
  // force transfer / admin
  "burnFrom(address,uint256)",
  // proxy
  "upgradeTo(address)",
  "upgradeToAndCall(address,bytes)",
  "changeAdmin(address)",
] as const;

/**
 * Mandatory ERC-20 entry points and read-only getters. Every conforming token
 * has these, so their presence is not a risk signal and reporting them as one
 * gave a plain token with ownership renounced a page full of privileged
 * functions. They stay in their own table for the ERC-20 shape heuristic.
 */
const STANDARD_SIGNATURES = [
  "transfer(address,uint256)",
  "transferFrom(address,address,uint256)",
  "balanceOf(address)",
  "totalSupply()",
  "owner()",
  "renounceOwnership()",
  "admin()",
  "implementation()",
] as const;

function selectorTable(signatures: readonly string[]): Record<string, string> {
  return Object.fromEntries(signatures.map((sig) => [toFunctionSelector(sig).slice(2), sig]));
}

/** Privilege selectors for bytecode scanning, keyed by selector without 0x. */
export const RISK_SELECTORS: Record<string, string> = selectorTable(PRIVILEGED_SIGNATURES);

/** Non-privileged ERC-20 / getter selectors, keyed by selector without 0x. */
export const STANDARD_SELECTORS: Record<string, string> = selectorTable(STANDARD_SIGNATURES);

export function networkToViemChain(network: NetworkConfig): Chain {
  return {
    id: network.chainId,
    name: network.name,
    nativeCurrency: network.nativeCurrency,
    rpcUrls: {
      default: { http: [network.rpcUrl].filter(Boolean) },
    },
    blockExplorers: {
      default: { name: "Explorer", url: network.explorerUrl },
    },
    testnet: network.isTestnet,
  };
}

export function createRpcClient(network: NetworkConfig): PublicClient | null {
  if (!network.rpcUrl) return null;
  return createPublicClient({
    chain: networkToViemChain(network),
    transport: fallback(
      [network.rpcUrl, ...(network.rpcFallbackUrls ?? [])]
        .filter(Boolean)
        .map((url) => http(url, { timeout: 20_000, retryCount: 1 })),
      { rank: false }
    ),
  }) as PublicClient;
}

export function normalizeAddress(addr: string): Address | null {
  if (!isAddress(addr)) return null;
  try {
    return getAddress(addr);
  } catch {
    return null;
  }
}

export async function readErc20Meta(
  client: PublicClient,
  address: Address
): Promise<{
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupply: string | null;
  owner: string | null;
}> {
  const safe = async <T>(fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch {
      return null;
    }
  };

  const [name, symbol, decimals, totalSupply, owner, getOwner] = await Promise.all([
    safe(() => client.readContract({ address, abi: ERC20_ABI, functionName: "name" })),
    safe(() => client.readContract({ address, abi: ERC20_ABI, functionName: "symbol" })),
    safe(() => client.readContract({ address, abi: ERC20_ABI, functionName: "decimals" })),
    safe(() => client.readContract({ address, abi: ERC20_ABI, functionName: "totalSupply" })),
    safe(() => client.readContract({ address, abi: ERC20_ABI, functionName: "owner" })),
    safe(() => client.readContract({ address, abi: ERC20_ABI, functionName: "getOwner" })),
  ]);

  return {
    name: name ?? null,
    symbol: symbol ?? null,
    decimals: decimals ?? null,
    totalSupply: totalSupply != null ? totalSupply.toString() : null,
    owner: (owner as string | null) ?? (getOwner as string | null) ?? null,
  };
}

/**
 * "The node did not answer" and "this address has no code" are different
 * facts, and treating them alike lets an RPC outage be reported as a verdict
 * about the token. Callers that make a risk claim must use probeCode.
 */
export type CodeProbe =
  | { ok: true; code: Hex | null }
  | { ok: false; error: string };

export async function probeCode(client: PublicClient, address: Address): Promise<CodeProbe> {
  try {
    const code = await client.getCode({ address });
    return { ok: true, code: !code || code === "0x" ? null : code };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * @deprecated Collapses a failed read to null, which is the conflation the
 * comment above forbids. Both remaining callers do draw a conclusion from the
 * null (apps/worker/src/arcDiscovery.ts skips the address and still commits the
 * block cursor, apps/api/src/routes/tokens.ts answers 404 "no contract here"),
 * so both need converting to probeCode before this can go.
 */
export async function getCode(client: PublicClient, address: Address): Promise<Hex | null> {
  const probe = await probeCode(client, address);
  return probe.ok ? probe.code : null;
}

export function bytecodeHash(code: Hex): string {
  return keccak256(code);
}

/** True when `needle` occurs in `hex` starting on a whole byte (even offset). */
function includesAtByteBoundary(hex: string, needle: string): boolean {
  for (let i = hex.indexOf(needle); i !== -1; i = hex.indexOf(needle, i + 1)) {
    if (i % 2 === 0) return true;
  }
  return false;
}

function scanTable(code: Hex, table: Record<string, string>): { selector: string; signature: string }[] {
  const hex = code.slice(2).toLowerCase();
  const found: { selector: string; signature: string }[] = [];
  for (const [sel, sig] of Object.entries(table)) {
    // A dispatcher can only route to a selector it pushes, so require the
    // PUSH4 opcode (0x63) immediately before it and require the match to land
    // on a byte boundary. A bare substring search also hits constants, address
    // literals and metadata, which invented mint and blacklist authorities.
    if (includesAtByteBoundary(hex, `63${sel}`)) {
      found.push({ selector: sel, signature: sig });
    }
  }
  return found;
}

/** Privileged functions found in the dispatcher. Never plain ERC-20 entry points. */
export function scanSelectors(code: Hex): { selector: string; signature: string }[] {
  return scanTable(code, RISK_SELECTORS);
}

/** ERC-20 / getter selectors, for shape detection rather than risk reporting. */
export function scanStandardSelectors(code: Hex): { selector: string; signature: string }[] {
  return scanTable(code, STANDARD_SELECTORS);
}

export function detectProxyHints(code: Hex): {
  isProxy: boolean;
  reasons: string[];
} {
  const hex = code.slice(2).toLowerCase();
  const reasons: string[] = [];
  // EIP-1967 implementation slot
  if (hex.includes("360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc")) {
    reasons.push("EIP-1967 implementation slot constant present");
  }
  // Same rule as scanSelectors: a bare four-byte search also hits constants and
  // packed data, and the two functions disagreeing about the same bytecode is
  // how a non-upgradeable token got a high "Upgradeable contract" signal.
  if (includesAtByteBoundary(hex, "633659cfe6") || includesAtByteBoundary(hex, "634f1ef286")) {
    reasons.push("upgradeTo / upgradeToAndCall selector present");
  }
  // minimal proxy (EIP-1167) prefix
  if (hex.includes("363d3d373d3d3d363d73")) {
    reasons.push("EIP-1167 minimal proxy pattern");
  }
  return { isProxy: reasons.length > 0, reasons };
}

export async function ethCall(
  client: PublicClient,
  args: {
    to: Address;
    data: Hex;
    from?: Address;
    value?: bigint;
  }
): Promise<{ success: boolean; data?: Hex; error?: string }> {
  try {
    const data = await client.call({
      to: args.to,
      data: args.data,
      account: args.from,
      value: args.value,
    });
    return { success: true, data: data.data };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: msg.slice(0, 500) };
  }
}

export { ERC20_ABI };
