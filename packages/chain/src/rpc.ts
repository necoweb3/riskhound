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

/** Common privilege selectors for bytecode scanning */
export const RISK_SELECTORS: Record<string, string> = {
  // mint / supply
  "40c10f19": "mint(address,uint256)",
  "a0712d68": "mint(uint256)",
  "449a52f8": "mintTo(address,uint256)",
  // pause / blacklist
  "8456cb59": "pause()",
  "3f4ba83a": "unpause()",
  "f9f92be4": "blacklist(address)",
  "e4997dc5": "addBlackList(address)",
  "0ecb93c0": "addToBlacklist(address)",
  "c3f909d4": "setBlacklistEnabled(bool)",
  // trading / max
  "8da5cb5b": "owner()",
  "715018a6": "renounceOwnership()",
  "f2fde38b": "transferOwnership(address)",
  "53d1c0d2": "setMaxTxAmount(uint256)",
  "7d1db4a5": "setMaxTxPercent(uint256)",
  "ec28438a": "setMaxTxAmount(uint256)",
  "cc1776d3": "setSellFee(uint256)",
  "c49b9a80": "setSwapAndLiquifyEnabled(bool)",
  // taxes
  "061c82d0": "setTaxFee(uint256)",
  "15ce80d0": "setLiquidityFee(uint256)",
  // force transfer / admin
  "79cc6790": "burnFrom(address,uint256)",
  "23b872dd": "transferFrom(address,address,uint256)",
  "a9059cbb": "transfer(address,uint256)",
  // proxy
  "3659cfe6": "upgradeTo(address)",
  "4f1ef286": "upgradeToAndCall(address,bytes)",
  "8f283970": "changeAdmin(address)",
  "f851a440": "admin()",
  "5c60da1b": "implementation()",
};

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

export async function getCode(client: PublicClient, address: Address): Promise<Hex | null> {
  try {
    const code = await client.getCode({ address });
    if (!code || code === "0x") return null;
    return code;
  } catch {
    return null;
  }
}

export function bytecodeHash(code: Hex): string {
  return keccak256(code);
}

export function scanSelectors(code: Hex): { selector: string; signature: string }[] {
  const hex = code.slice(2).toLowerCase();
  const found: { selector: string; signature: string }[] = [];
  for (const [sel, sig] of Object.entries(RISK_SELECTORS)) {
    // PUSH4 selector patterns commonly appear as 63XXXXXXXX or in jump tables
    if (hex.includes(sel)) {
      found.push({ selector: sel, signature: sig });
    }
  }
  return found;
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
  if (hex.includes("3659cfe6") || hex.includes("4f1ef286")) {
    reasons.push("upgradeTo / upgradeToAndCall selector present");
  }
  // minimal proxy (EIP-1167) prefix
  if (hex.startsWith("363d3d373d3d3d363d73") || hex.includes("363d3d373d3d3d363d73")) {
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
