import { prisma } from "./index.js";
import { jstr } from "./json.js";

type EvidenceGraph = {
  nodes: { id: string; type: string; chain?: string }[];
  edges: { id: string; source: string; target: string; type: string; strength: string; evidence: unknown[]; label?: string }[];
};

function addressFromNode(id: string) {
  const address = id.split(":").at(-1)?.toLowerCase() ?? "";
  return /^0x[a-f0-9]{40}$/.test(address) ? address : null;
}

export async function persistEvidenceGraph(graph: EvidenceGraph, chain = "arc_testnet") {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const edge of graph.edges) {
    const source = addressFromNode(edge.source);
    const target = addressFromNode(edge.target);
    if (!source || !target || source === target) continue;
    const sourceNode = nodes.get(edge.source);
    const targetNode = nodes.get(edge.target);
    const fingerprint = `${chain}:${source}:${target}:${edge.type}`.toLowerCase();
    const confidence = edge.strength === "definitive" || edge.strength === "strong" ? "high" : "medium";
    await prisma.graphEdgeRow.upsert({
      where: { fingerprint },
      create: {
        fingerprint,
        sourceId: source,
        targetId: target,
        sourceType: sourceNode?.type ?? "address",
        targetType: targetNode?.type ?? "address",
        edgeType: edge.type,
        strength: edge.strength,
        chain,
        confidence,
        evidenceJson: jstr(edge.evidence),
        label: edge.label,
        serviceExcluded: false,
      },
      update: { strength: edge.strength, confidence, evidenceJson: jstr(edge.evidence), label: edge.label },
    });
  }
}

export async function persistAutomaticRiskEvents(input: {
  tokenId: string;
  tokenAddress: string;
  chain: string;
  findings: { id: string; name: string; summary: string; severity: string; controllerAddress?: string; evidence: unknown[] }[];
}) {
  for (const finding of input.findings.filter((f) => f.severity === "critical" || f.severity === "high")) {
    const eventClass = /liquidity|lp/i.test(finding.name)
      ? "liquidity_removal"
      : /sell|honeypot/i.test(finding.name)
        ? "suspicious_rug_behavior"
        : "heavy_insider_control";
    const existing = await prisma.riskEvent.findFirst({
      where: {
        chain: input.chain,
        tokenAddress: input.tokenAddress,
        title: finding.name,
        createdAt: { gte: new Date(Date.now() - 86_400_000) },
      },
    });
    if (existing) continue;
    await prisma.riskEvent.create({
      data: {
        chain: input.chain,
        eventClass,
        title: finding.name,
        detail: finding.summary,
        tokenId: input.tokenId,
        tokenAddress: input.tokenAddress,
        addressesJson: jstr([input.tokenAddress, finding.controllerAddress].filter(Boolean)),
        confidence: "medium",
        autoDetected: true,
        manualStatus: "pending",
        evidenceJson: jstr(finding.evidence),
        occurredAt: new Date(),
      },
    });
  }
}
