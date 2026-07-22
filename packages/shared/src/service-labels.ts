/**
 * Known infrastructure addresses that must NOT be treated as
 * common-ownership evidence in cluster / funding analysis.
 */

export interface KnownService {
  address: string;
  chain: "*" | string;
  label: string;
  kind: "cex" | "bridge" | "router" | "factory" | "multisig" | "system" | "token" | "other";
}

/** Lowercase addresses */
export const KNOWN_SERVICES: KnownService[] = [
  // Arc system / common
  {
    address: "0x3600000000000000000000000000000000000000",
    chain: "arc_testnet",
    label: "Arc USDC",
    kind: "token",
  },
  {
    address: "0x0000000000000000000000000000000000000000",
    chain: "*",
    label: "Zero address",
    kind: "system",
  },
  {
    address: "0x000000000000000000000000000000000000dead",
    chain: "*",
    label: "Burn address",
    kind: "system",
  },
];

const serviceSet = new Map(
  KNOWN_SERVICES.map((s) => [`${s.chain}:${s.address.toLowerCase()}`, s])
);

export function isKnownService(address: string, chain?: string): KnownService | null {
  const a = address.toLowerCase();
  if (chain) {
    const hit = serviceSet.get(`${chain}:${a}`);
    if (hit) return hit;
  }
  const any = serviceSet.get(`*:${a}`);
  if (any) return any;
  // also scan chain-specific when chain unknown
  for (const s of KNOWN_SERVICES) {
    if (s.address.toLowerCase() === a && (s.chain === "*" || !chain || s.chain === chain)) {
      return s;
    }
  }
  return null;
}

export function shouldIgnoreForOwnership(address: string, chain?: string): boolean {
  const s = isKnownService(address, chain);
  if (!s) return false;
  return ["cex", "bridge", "router", "factory", "system", "token"].includes(s.kind);
}
