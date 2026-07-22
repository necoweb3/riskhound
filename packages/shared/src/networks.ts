/**
 * Central network configuration.
 * Arc mainnet is NOT active. Do not pretend it is.
 * Payment network is independent of analysis networks.
 */

export type NetworkKey = "arc_testnet" | "robinhood" | "base" | "base_sepolia";

export interface NetworkConfig {
  key: NetworkKey;
  name: string;
  chainId: number;
  isTestnet: boolean;
  isPaymentNetwork: boolean;
  isAnalysisNetwork: boolean;
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
  rpcUrl: string;
  rpcFallbackUrls?: string[];
  wsUrl?: string;
  explorerUrl: string;
  explorerApiUrl: string;
  explorerV2Url: string;
  usdcAddress?: string;
  /** Dual-decimal note for Arc: native gas uses 18, ERC-20 USDC uses 6 */
  notes?: string[];
}

export function loadNetworksFromEnv(env: NodeJS.ProcessEnv = process.env): Record<NetworkKey, NetworkConfig> {
  return {
    arc_testnet: {
      key: "arc_testnet",
      name: "Arc Testnet",
      chainId: Number(env.ARC_CHAIN_ID ?? 5042002),
      isTestnet: true,
      isPaymentNetwork: true,
      isAnalysisNetwork: true,
      nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
      rpcUrl: env.ARC_RPC_URL ?? "https://rpc.drpc.testnet.arc.network",
      rpcFallbackUrls: [
        "https://rpc.testnet.arc.network",
        "https://rpc.blockdaemon.testnet.arc.network",
        "https://rpc.quicknode.testnet.arc.network",
      ],
      wsUrl: env.ARC_WS_URL ?? "wss://rpc.testnet.arc.network",
      explorerUrl: env.ARC_EXPLORER_URL ?? "https://testnet.arcscan.app",
      explorerApiUrl: env.ARC_EXPLORER_API ?? "https://testnet.arcscan.app/api",
      explorerV2Url: env.ARC_EXPLORER_V2 ?? "https://testnet.arcscan.app/api/v2",
      usdcAddress: "0x3600000000000000000000000000000000000000",
      notes: [
        "USDC is native gas (18 decimals for native, 6 for ERC-20 USDC).",
        "Arc mainnet is not live; this config is testnet-only.",
      ],
    },
    robinhood: {
      key: "robinhood",
      name: "Robinhood Chain",
      chainId: Number(env.ROBINHOOD_CHAIN_ID ?? 4663),
      isTestnet: false,
      isPaymentNetwork: false,
      isAnalysisNetwork: false,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrl: env.ROBINHOOD_RPC_URL ?? "",
      explorerUrl: env.ROBINHOOD_EXPLORER_URL ?? "https://robinhoodchain.blockscout.com",
      explorerApiUrl: env.ROBINHOOD_EXPLORER_API ?? "https://robinhoodchain.blockscout.com/api",
      explorerV2Url: env.ROBINHOOD_EXPLORER_V2 ?? "https://robinhoodchain.blockscout.com/api/v2",
      notes: [
        "Supporting creator-history evidence only; never exposed as a RiskHound product network.",
      ],
    },
    base: {
      key: "base",
      name: "Base",
      chainId: Number(env.PAYMENT_CHAIN_ID ?? 8453),
      isTestnet: false,
      isPaymentNetwork: true,
      isAnalysisNetwork: false,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrl: env.PAYMENT_RPC_URL ?? "https://mainnet.base.org",
      explorerUrl: "https://basescan.org",
      explorerApiUrl: "https://api.basescan.org/api",
      explorerV2Url: "https://base.blockscout.com/api/v2",
      usdcAddress: env.PAYMENT_USDC_ADDRESS ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      notes: ["Default x402 settlement network until Arc mainnet payments are available."],
    },
    base_sepolia: {
      key: "base_sepolia",
      name: "Base Sepolia",
      chainId: 84532,
      isTestnet: true,
      isPaymentNetwork: true,
      isAnalysisNetwork: false,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrl: "https://sepolia.base.org",
      explorerUrl: "https://sepolia.basescan.org",
      explorerApiUrl: "https://api-sepolia.basescan.org/api",
      explorerV2Url: "https://base-sepolia.blockscout.com/api/v2",
      usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      notes: ["Optional test payment network."],
    },
  };
}

export function getAnalysisNetworks(networks = loadNetworksFromEnv()) {
  return Object.values(networks).filter((n) => n.isAnalysisNetwork);
}

export function getPaymentNetwork(networks = loadNetworksFromEnv()): NetworkConfig {
  const key = (process.env.PAYMENT_NETWORK ?? "base") as NetworkKey;
  const network = networks[key];
  if (!network || !network.isPaymentNetwork || !network.usdcAddress) {
    throw new Error(`Unsupported PAYMENT_NETWORK: ${key}`);
  }
  return network;
}

export function explorerAddressUrl(network: NetworkConfig, address: string) {
  return `${network.explorerUrl}/address/${address}`;
}

export function explorerTxUrl(network: NetworkConfig, hash: string) {
  return `${network.explorerUrl}/tx/${hash}`;
}

export function explorerTokenUrl(network: NetworkConfig, address: string) {
  return `${network.explorerUrl}/token/${address}`;
}
