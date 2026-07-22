export type ArcProtocolKind =
  | "stablecoin"
  | "cctp"
  | "gateway"
  | "dex"
  | "launchpad"
  | "router"
  | "liquidity_locker";

export type ProtocolVerification =
  | "official_documentation"
  | "verified_onchain"
  | "observed_unverified";

export interface ArcProtocolContract {
  key: string;
  name: string;
  kind: ArcProtocolKind;
  environment: "arc_testnet" | "arc_unannounced_mainnet";
  address: `0x${string}`;
  verification: ProtocolVerification;
  sourceUrl: string;
  notes?: string;
}

const ARC_CONTRACT_DOCS = "https://docs.arc.io/arc/references/contract-addresses";

/**
 * Canonical Arc contracts accepted by live analysis. This list intentionally
 * contains only addresses published by Arc. Community-reported/private
 * mainnet candidates must live in an evidence queue, never in this registry.
 */
export const ARC_PROTOCOL_CONTRACTS: readonly ArcProtocolContract[] = [
  {
    key: "usdc",
    name: "USDC",
    kind: "stablecoin",
    environment: "arc_testnet",
    address: "0x3600000000000000000000000000000000000000",
    verification: "official_documentation",
    sourceUrl: ARC_CONTRACT_DOCS,
    notes: "ERC-20 interface uses 6 decimals; Arc native USDC gas accounting uses 18 decimals.",
  },
  {
    key: "cctp_token_messenger_v2",
    name: "CCTP TokenMessengerV2",
    kind: "cctp",
    environment: "arc_testnet",
    address: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
    verification: "official_documentation",
    sourceUrl: ARC_CONTRACT_DOCS,
  },
  {
    key: "cctp_message_transmitter_v2",
    name: "CCTP MessageTransmitterV2",
    kind: "cctp",
    environment: "arc_testnet",
    address: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
    verification: "official_documentation",
    sourceUrl: ARC_CONTRACT_DOCS,
  },
  {
    key: "cctp_token_minter_v2",
    name: "CCTP TokenMinterV2",
    kind: "cctp",
    environment: "arc_testnet",
    address: "0xb43db544E2c27092c107639Ad201b3dEfAbcF192",
    verification: "official_documentation",
    sourceUrl: ARC_CONTRACT_DOCS,
  },
  {
    key: "gateway_wallet",
    name: "Gateway Wallet",
    kind: "gateway",
    environment: "arc_testnet",
    address: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    verification: "official_documentation",
    sourceUrl: ARC_CONTRACT_DOCS,
  },
  {
    key: "gateway_minter",
    name: "Gateway Minter",
    kind: "gateway",
    environment: "arc_testnet",
    address: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
    verification: "official_documentation",
    sourceUrl: ARC_CONTRACT_DOCS,
  },
] as const;

export const ARC_OBSERVED_MAINNET_CHAIN_ID = 5042;
const ARC_OBSERVED_EXPLORER = "https://megaeth-pump-ok-moon.poptyedev.com";

/**
 * Contracts independently observed on the running, unannounced Arc mainnet.
 * These are real onchain observations, but remain segregated from the
 * official registry until Arc publishes the production network details.
 */
export const ARC_OBSERVED_MAINNET_CONTRACTS: readonly ArcProtocolContract[] = [
  {
    key: "observed_mainnet_usdc",
    name: "USDC",
    kind: "stablecoin",
    environment: "arc_unannounced_mainnet",
    address: "0x3600000000000000000000000000000000000000",
    verification: "observed_unverified",
    sourceUrl: `${ARC_OBSERVED_EXPLORER}/token/0x3600000000000000000000000000000000000000`,
    notes: "Live Blockscout data observed on chain ID 5042; network not publicly announced by Arc.",
  },
  {
    key: "observed_mainnet_message_transmitter_v2",
    name: "CCTP MessageTransmitterV2 proxy",
    kind: "cctp",
    environment: "arc_unannounced_mainnet",
    address: "0x81d40f21f12a8f0e3252bccb954d722d4c464b64",
    verification: "observed_unverified",
    sourceUrl: `${ARC_OBSERVED_EXPLORER}/address/0x81d40f21f12a8f0e3252bccb954d722d4c464b64`,
  },
  {
    key: "observed_mainnet_token_messenger_v2",
    name: "CCTP TokenMessengerV2 proxy",
    kind: "cctp",
    environment: "arc_unannounced_mainnet",
    address: "0x28b5a0e9c621a5badaa536219b3a228c8168cf5d",
    verification: "observed_unverified",
    sourceUrl: `${ARC_OBSERVED_EXPLORER}/address/0x28b5a0e9c621a5badaa536219b3a228c8168cf5d`,
  },
  {
    key: "observed_mainnet_token_minter_v2",
    name: "CCTP TokenMinterV2",
    kind: "cctp",
    environment: "arc_unannounced_mainnet",
    address: "0xfd78ee919681417d192449715b2594ab58f5d002",
    verification: "observed_unverified",
    sourceUrl: `${ARC_OBSERVED_EXPLORER}/address/0xfd78ee919681417d192449715b2594ab58f5d002`,
  },
  {
    key: "observed_mainnet_cctp_router",
    name: "Observed CCTP pre-bridge router",
    kind: "router",
    environment: "arc_unannounced_mainnet",
    address: "0xb3fa262d0fb521cc93be83d87b322b8a23daf3f0",
    verification: "observed_unverified",
    sourceUrl: `${ARC_OBSERVED_EXPLORER}/address/0xb3fa262d0fb521cc93be83d87b322b8a23daf3f0`,
    notes: "Verified proxy bytecode observed; operator endorsement and public production status are not assumed.",
  },
] as const;

const byAddress = new Map(
  ARC_PROTOCOL_CONTRACTS.map((contract) => [contract.address.toLowerCase(), contract])
);

export function getArcProtocolContract(address: string): ArcProtocolContract | null {
  return byAddress.get(address.toLowerCase()) ?? null;
}

export function isOfficialArcProtocolContract(address: string): boolean {
  return getArcProtocolContract(address)?.verification === "official_documentation";
}

export function getObservedArcMainnetContract(address: string): ArcProtocolContract | null {
  return (
    ARC_OBSERVED_MAINNET_CONTRACTS.find(
      (contract) => contract.address.toLowerCase() === address.toLowerCase()
    ) ?? null
  );
}
