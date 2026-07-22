import { loadNetworksFromEnv, type NetworkConfig, type NetworkKey } from "@rugkiller/shared";
import { BlockscoutClient } from "./blockscout.js";
import { createRpcClient, type PublicClient } from "./rpc.js";

export interface ChainClients {
  network: NetworkConfig;
  explorer: BlockscoutClient;
  rpc: PublicClient | null;
}

export function getChainClients(
  key: NetworkKey,
  env: NodeJS.ProcessEnv = process.env
): ChainClients {
  const networks = loadNetworksFromEnv(env);
  const network = networks[key];
  if (!network) throw new Error(`Unknown network: ${key}`);

  return {
    network,
    explorer: new BlockscoutClient({
      apiUrl: network.explorerApiUrl,
      v2Url: network.explorerV2Url,
      chainKey: network.key,
    }),
    rpc: createRpcClient(network),
  };
}

export function getArcClients(env?: NodeJS.ProcessEnv) {
  return getChainClients("arc_testnet", env);
}

export function getRobinhoodClients(env?: NodeJS.ProcessEnv) {
  return getChainClients("robinhood", env);
}
