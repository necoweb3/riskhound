import {
  type EvidenceRef,
  type RiskFinding,
  CATEGORY_LABELS,
} from "@rugkiller/shared";
import {
  type BlockscoutClient,
  bytecodeHash,
  detectProxyHints,
  getCode,
  readErc20Meta,
  scanSelectors,
  type PublicClient,
} from "@rugkiller/chain";
import type { Address, Hex } from "viem";

export interface ContractAnalysisInput {
  chain: string;
  address: Address;
  rpc: PublicClient | null;
  explorer: BlockscoutClient;
  explorerUrl: string;
}

export interface ContractAnalysisResult {
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupply: string | null;
  owner: string | null;
  isVerified: boolean;
  isProxy: boolean;
  proxyReasons: string[];
  bytecodeHash: string | null;
  hasCode: boolean;
  templateHint: string | null;
  deployer: string | null;
  deployTxHash: string | null;
  findings: RiskFinding[];
  selectors: { selector: string; signature: string }[];
  sourceUnavailable: boolean;
  dataSourcesUsed: string[];
  errors: string[];
}

function ev(
  chain: string,
  type: EvidenceRef["type"],
  value: string,
  label?: string,
  url?: string
): EvidenceRef {
  return { type, chain, value, label, url };
}

const SELECTOR_RISKS: Record<
  string,
  { name: string; severity: RiskFinding["severity"]; category: RiskFinding["category"]; why: string; status: RiskFinding["status"] }
> = {
  "mint(address,uint256)": {
    name: "Mint authority present",
    severity: "high",
    category: "contract",
    why: "Owner or privileged role may inflate supply, diluting holders.",
    status: "theoretical",
  },
  "mint(uint256)": {
    name: "Mint authority present",
    severity: "high",
    category: "contract",
    why: "Supply can be increased after deployment.",
    status: "theoretical",
  },
  "pause()": {
    name: "Transfers can be paused",
    severity: "high",
    category: "owner_admin",
    why: "Privileged role can freeze all transfers including sells.",
    status: "theoretical",
  },
  "blacklist(address)": {
    name: "Blacklist capability",
    severity: "high",
    category: "owner_admin",
    why: "Specific addresses can be blocked from transferring.",
    status: "theoretical",
  },
  "addBlackList(address)": {
    name: "Blacklist capability",
    severity: "high",
    category: "owner_admin",
    why: "Specific addresses can be blocked from transferring.",
    status: "theoretical",
  },
  "addToBlacklist(address)": {
    name: "Blacklist capability",
    severity: "high",
    category: "owner_admin",
    why: "Specific addresses can be blocked from transferring.",
    status: "theoretical",
  },
  "setMaxTxAmount(uint256)": {
    name: "Mutable max transaction amount",
    severity: "medium",
    category: "owner_admin",
    why: "Owner can change trade size limits after launch.",
    status: "theoretical",
  },
  "setSellFee(uint256)": {
    name: "Mutable sell fee",
    severity: "high",
    category: "owner_admin",
    why: "Sell tax can be raised to extreme levels, trapping sellers.",
    status: "theoretical",
  },
  "setTaxFee(uint256)": {
    name: "Mutable tax fee",
    severity: "high",
    category: "owner_admin",
    why: "Tax parameters can be changed by privileged roles.",
    status: "theoretical",
  },
  "upgradeTo(address)": {
    name: "Upgradeable implementation",
    severity: "critical",
    category: "contract",
    why: "Logic can be replaced after users buy the token.",
    status: "theoretical",
  },
  "upgradeToAndCall(address,bytes)": {
    name: "Upgradeable implementation",
    severity: "critical",
    category: "contract",
    why: "Logic can be replaced and immediately executed.",
    status: "theoretical",
  },
  "changeAdmin(address)": {
    name: "Proxy admin transfer",
    severity: "high",
    category: "owner_admin",
    why: "Proxy admin control can move to another wallet.",
    status: "theoretical",
  },
  "burnFrom(address,uint256)": {
    name: "burnFrom privilege surface",
    severity: "medium",
    category: "contract",
    why: "If unrestricted, balances can be reduced without user consent.",
    status: "theoretical",
  },
};

export async function analyzeContract(input: ContractAnalysisInput): Promise<ContractAnalysisResult> {
  const errors: string[] = [];
  const dataSourcesUsed: string[] = [];
  const findings: RiskFinding[] = [];
  let name: string | null = null;
  let symbol: string | null = null;
  let decimals: number | null = null;
  let totalSupply: string | null = null;
  let owner: string | null = null;
  let isVerified = false;
  let isProxy = false;
  let proxyReasons: string[] = [];
  let codeHash: string | null = null;
  let hasCode = false;
  let templateHint: string | null = null;
  let deployer: string | null = null;
  let deployTxHash: string | null = null;
  let selectors: { selector: string; signature: string }[] = [];
  let sourceUnavailable = false;
  let code: Hex | null = null;

  // Explorer address / token
  try {
    const addrInfo = await input.explorer.getAddress(input.address);
    dataSourcesUsed.push(`${input.chain}:blockscout_address`);
    if (addrInfo) {
      isVerified = Boolean(addrInfo.is_verified);
      if (addrInfo.proxy_type || (addrInfo.implementations && addrInfo.implementations.length > 0)) {
        isProxy = true;
        proxyReasons.push(`Explorer reports proxy_type=${addrInfo.proxy_type ?? "unknown"}`);
      }
      deployer = addrInfo.creator_address_hash?.toLowerCase() ?? null;
      deployTxHash = addrInfo.creation_tx_hash ?? null;
      if (addrInfo.token) {
        name = addrInfo.token.name ?? name;
        symbol = addrInfo.token.symbol ?? symbol;
        if (addrInfo.token.decimals != null) decimals = Number(addrInfo.token.decimals);
        totalSupply = addrInfo.token.total_supply ?? totalSupply;
      }
    }
  } catch (e) {
    errors.push(`explorer address: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    const token = await input.explorer.getToken(input.address);
    dataSourcesUsed.push(`${input.chain}:blockscout_token`);
    if (token) {
      name = token.name ?? name;
      symbol = token.symbol ?? symbol;
      if (token.decimals != null) decimals = Number(token.decimals);
      totalSupply = token.total_supply ?? totalSupply;
    }
  } catch (e) {
    errors.push(`explorer token: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    const creation = await input.explorer.getContractCreation(input.address);
    dataSourcesUsed.push(`${input.chain}:blockscout_creation`);
    if (creation) {
      deployer = creation.contractCreator?.toLowerCase() ?? deployer;
      deployTxHash = creation.txHash ?? deployTxHash;
    }
  } catch (e) {
    errors.push(`explorer creation: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    const source = await input.explorer.getContractSource(input.address);
    dataSourcesUsed.push(`${input.chain}:blockscout_source`);
    if (source) {
      isVerified = Boolean(source.is_verified) || isVerified;
      if (source.name) templateHint = source.name;
    } else {
      sourceUnavailable = true;
    }
  } catch {
    sourceUnavailable = true;
  }

  if (input.rpc) {
    try {
      const meta = await readErc20Meta(input.rpc, input.address);
      dataSourcesUsed.push(`${input.chain}:rpc_erc20`);
      name = meta.name ?? name;
      symbol = meta.symbol ?? symbol;
      decimals = meta.decimals ?? decimals;
      totalSupply = meta.totalSupply ?? totalSupply;
      owner = meta.owner?.toLowerCase() ?? owner;
    } catch (e) {
      errors.push(`rpc meta: ${e instanceof Error ? e.message : String(e)}`);
    }

    try {
      code = await getCode(input.rpc, input.address);
      dataSourcesUsed.push(`${input.chain}:rpc_code`);
      hasCode = Boolean(code);
      if (code) {
        codeHash = bytecodeHash(code);
        selectors = scanSelectors(code);
        const proxy = detectProxyHints(code);
        if (proxy.isProxy) {
          isProxy = true;
          proxyReasons = [...new Set([...proxyReasons, ...proxy.reasons])];
        }
      }
    } catch (e) {
      errors.push(`rpc code: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    errors.push("RPC unavailable for this chain. Bytecode analysis is limited.");
  }

  if (!hasCode && input.rpc) {
    findings.push({
      id: `no-code-${input.address}`,
      category: "data_gaps",
      name: "No contract code at address",
      severity: "critical",
      status: "observed",
      summary: "Address has no deployed bytecode on the analysis network.",
      whyItMatters: "Not a token contract, or wrong network/address.",
      evidence: [ev(input.chain, "contract", input.address, "address", `${input.explorerUrl}/address/${input.address}`)],
      source: "automatic",
    });
  }

  if (!isVerified && hasCode) {
    findings.push({
      id: `unverified-${input.address}`,
      category: "contract",
      name: "Contract source not verified",
      severity: "medium",
      status: "observed",
      summary: "Explorer does not show verified source code.",
      whyItMatters: "Harder to review privileges; analysis relies on bytecode and behavior.",
      evidence: [ev(input.chain, "contract", input.address, "unverified", `${input.explorerUrl}/address/${input.address}`)],
      source: "automatic",
    });
  }

  if (isProxy) {
    findings.push({
      id: `proxy-${input.address}`,
      category: "contract",
      name: "Proxy / upgradeable pattern detected",
      severity: "high",
      status: "observed",
      summary: proxyReasons.join("; ") || "Proxy indicators present",
      whyItMatters: "Implementation may change after users acquire tokens.",
      controllerAddress: owner ?? undefined,
      evidence: [
        ev(input.chain, "contract", input.address, "proxy", `${input.explorerUrl}/address/${input.address}`),
        ...proxyReasons.map((r) => ev(input.chain, "bytecode", r)),
      ],
      source: "automatic",
    });
  }

  const seenRisk = new Set<string>();
  for (const sel of selectors) {
    const risk = SELECTOR_RISKS[sel.signature];
    if (!risk) continue;
    if (seenRisk.has(risk.name)) continue;
    seenRisk.add(risk.name);
    findings.push({
      id: `sel-${sel.selector}-${input.address}`,
      category: risk.category,
      name: risk.name,
      severity: risk.severity,
      status: risk.status,
      summary: `Bytecode contains selector for ${sel.signature} (0x${sel.selector}).`,
      whyItMatters: risk.why,
      relatedFunction: sel.signature,
      controllerAddress: owner ?? undefined,
      evidence: [
        ev(input.chain, "bytecode", `0x${sel.selector}`, sel.signature),
        ev(input.chain, "contract", input.address),
      ],
      source: "automatic",
    });
  }

  if (owner && owner !== "0x0000000000000000000000000000000000000000") {
    findings.push({
      id: `owner-active-${input.address}`,
      category: "owner_admin",
      name: "Active owner address",
      severity: "medium",
      status: "observed",
      summary: `owner() returns ${owner}`,
      whyItMatters: "Privileged admin functions may still be callable.",
      controllerAddress: owner,
      relatedFunction: "owner()",
      evidence: [ev(input.chain, "address", owner, "owner", `${input.explorerUrl}/address/${owner}`)],
      source: "automatic",
    });
  } else if (owner === "0x0000000000000000000000000000000000000000") {
    findings.push({
      id: `owner-renounced-${input.address}`,
      category: "owner_admin",
      name: "Owner renounced (zero address)",
      severity: "info",
      status: "observed",
      summary: "owner() returns zero address.",
      whyItMatters: "Classic owner path appears renounced; other admin roles may still exist.",
      relatedFunction: "owner()",
      evidence: [ev(input.chain, "address", owner, "owner")],
      source: "automatic",
    });
  }

  // silence unused import warning pattern
  void CATEGORY_LABELS;

  return {
    name,
    symbol,
    decimals,
    totalSupply,
    owner,
    isVerified,
    isProxy,
    proxyReasons,
    bytecodeHash: codeHash,
    hasCode,
    templateHint,
    deployer,
    deployTxHash,
    findings,
    selectors,
    sourceUnavailable,
    dataSourcesUsed,
    errors,
  };
}
