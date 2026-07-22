import type {
  CrossChainLink,
  FundingGraph,
  GraphEdge,
  GraphNode,
  HolderInfo,
  LinkStrength,
} from "@rugkiller/shared";

export function buildFundingGraph(opts: {
  tokenAddress: string;
  tokenSymbol?: string | null;
  deployer?: string | null;
  holders?: HolderInfo[];
  links?: CrossChainLink[];
  firstFunder?: string | null;
}): FundingGraph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  const addNode = (n: GraphNode) => {
    if (!nodes.has(n.id)) nodes.set(n.id, n);
  };

  const tokenId = `token:arc_testnet:${opts.tokenAddress.toLowerCase()}`;
  addNode({
    id: tokenId,
    type: "token",
    label: opts.tokenSymbol ?? opts.tokenAddress.slice(0, 10),
    chain: "arc_testnet",
  });

  if (opts.deployer) {
    const depId = `wallet:arc_testnet:${opts.deployer.toLowerCase()}`;
    addNode({
      id: depId,
      type: "deployer",
      label: short(opts.deployer),
      chain: "arc_testnet",
    });
    edges.push({
      id: `deployed-${depId}-${tokenId}`,
      source: depId,
      target: tokenId,
      type: "deployed",
      strength: "definitive",
      evidence: [
        {
          type: "address",
          chain: "arc_testnet",
          value: opts.deployer,
          label: "deployer",
        },
      ],
      label: "deployed",
    });

    if (opts.firstFunder) {
      const fId = `wallet:arc_testnet:${opts.firstFunder.toLowerCase()}`;
      addNode({
        id: fId,
        type: "funding_wallet",
        label: short(opts.firstFunder),
        chain: "arc_testnet",
      });
      edges.push({
        id: `funded-${fId}-${depId}`,
        source: fId,
        target: depId,
        type: "funded",
        strength: "strong",
        evidence: [
          {
            type: "address",
            chain: "arc_testnet",
            value: opts.firstFunder,
            label: "first funder",
          },
        ],
        label: "funded",
      });
    }
  }

  for (const h of (opts.holders ?? []).slice(0, 12)) {
    if (h.labels.includes("known_service")) continue;
    const id = `wallet:arc_testnet:${h.address}`;
    addNode({
      id,
      type: "wallet",
      label: short(h.address) + (h.pct != null ? ` (${h.pct.toFixed(1)}%)` : ""),
      chain: "arc_testnet",
      meta: { pct: h.pct },
    });
    edges.push({
      id: `hold-${id}-${tokenId}`,
      source: id,
      target: tokenId,
      type: "bought",
      strength: "medium",
      evidence: [{ type: "address", chain: "arc_testnet", value: h.address }],
      label: "holds",
    });
  }

  for (const l of opts.links ?? []) {
    const sId = `wallet:${l.fromChain}:${l.fromAddress}`;
    const tId = `wallet:${l.toChain}:${l.toAddress}`;
    addNode({
      id: sId,
      type: "wallet",
      label: short(l.fromAddress),
      chain: l.fromChain,
    });
    addNode({
      id: tId,
      type: "wallet",
      label: short(l.toAddress),
      chain: l.toChain,
    });
    edges.push({
      id: `xc-${l.id}`,
      source: sId,
      target: tId,
      type: l.strength === "definitive" ? "bridged" : "funded",
      strength: l.strength,
      evidence: l.evidence,
      label: l.strength,
    });
  }

  // hops to risk: any node that appears in strong/definitive cross-chain risk links
  const riskAddrs = new Set(
    (opts.links ?? [])
      .filter((l) => l.strength === "definitive" || l.strength === "strong")
      .flatMap((l) => [l.fromAddress, l.toAddress])
  );

  const hopsToRisk = [...nodes.values()]
    .filter((n) => n.type === "wallet" || n.type === "deployer" || n.type === "funding_wallet")
    .map((n) => {
      const addr = n.id.split(":").pop()!;
      if (riskAddrs.has(addr)) return { address: addr, hops: 0 };
      // 1-hop if connected by edge to risk addr
      const connected = edges.some((e) => {
        const s = e.source.split(":").pop()!;
        const t = e.target.split(":").pop()!;
        return (
          (s === addr && riskAddrs.has(t)) || (t === addr && riskAddrs.has(s))
        );
      });
      return { address: addr, hops: connected ? 1 : null };
    });

  return {
    nodes: [...nodes.values()],
    edges: prioritizeEdges(edges),
    hopsToRisk,
    pruned: true,
    note: "Graph is pruned to highest-signal links (deploy, funding, top holders, cross-chain).",
  };
}

function short(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function prioritizeEdges(edges: GraphEdge[]): GraphEdge[] {
  const rank: Record<LinkStrength, number> = {
    definitive: 0,
    strong: 1,
    medium: 2,
    weak_behavioral: 3,
  };
  return [...edges]
    .sort((a, b) => rank[a.strength] - rank[b.strength])
    .slice(0, 40);
}
