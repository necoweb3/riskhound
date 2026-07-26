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

/**
 * Mirrors EventClass in @rugkiller/shared. This package has no dependency on
 * shared, so the union is restated here and must stay in sync with it.
 */
type EventClass =
  | "confirmed_malicious"
  | "high_risk_exit"
  | "suspicious_rug_behavior"
  | "honeypot_behavior"
  | "abandoned_token"
  | "heavy_insider_control"
  | "insufficient_evidence";

/**
 * Classification is keyed on the finding's category, which is a stable part of
 * the risk model, rather than on its display name: copy changes silently
 * reclassify events, and the old regex fell through to heavy_insider_control
 * for anything it did not recognise, asserting insider control with no evidence
 * for it. confirmed_malicious is deliberately absent because it requires a
 * reviewed decision, never an automatic one.
 */
const EVENT_CLASS_BY_CATEGORY: Record<string, EventClass> = {
  contract: "suspicious_rug_behavior",
  owner_admin: "heavy_insider_control",
  buy_sell: "honeypot_behavior",
  liquidity: "high_risk_exit",
  holder_concentration: "heavy_insider_control",
  insider_links: "heavy_insider_control",
  deployer_history: "suspicious_rug_behavior",
  cross_chain: "suspicious_rug_behavior",
  market_behavior: "suspicious_rug_behavior",
  data_gaps: "insufficient_evidence",
};

export async function persistAutomaticRiskEvents(input: {
  tokenId: string;
  tokenAddress: string;
  chain: string;
  findings: { id: string; category: string; name: string; summary: string; severity: string; controllerAddress?: string; evidence: unknown[] }[];
}) {
  for (const finding of input.findings.filter((f) => f.severity === "critical" || f.severity === "high")) {
    // An unmapped category is a gap in this table, not a licence to guess.
    const eventClass = EVENT_CLASS_BY_CATEGORY[finding.category] ?? "insufficient_evidence";
    // No time window: a token that stays flagged for the same reason used to
    // gain one identical row per day forever. The open automatic event is
    // refreshed instead so the feed keeps one row per distinct finding.
    const existing = await prisma.riskEvent.findFirst({
      where: {
        chain: input.chain,
        tokenAddress: input.tokenAddress,
        title: finding.name,
        autoDetected: true,
      },
      // Rows written before this dedupe existed can still be duplicated, so the
      // refresh is pinned to the oldest match rather than an arbitrary one.
      orderBy: { occurredAt: "asc" },
    });
    if (existing) {
      // "confirmed" and "rejected" are the reviewed states. Rewriting the
      // detail or evidence underneath a reviewer's decision would leave it
      // standing on proof nobody looked at, and a degraded run that produced no
      // evidence refs would strip the proof from a confirmed event entirely.
      const reviewed = existing.manualStatus === "confirmed" || existing.manualStatus === "rejected";
      if (!reviewed) {
        await prisma.riskEvent.update({
          where: { id: existing.id },
          // occurredAt is left alone so it still records the first observation.
          data: { detail: finding.summary, evidenceJson: jstr(finding.evidence), eventClass },
        });
      }
      continue;
    }
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
