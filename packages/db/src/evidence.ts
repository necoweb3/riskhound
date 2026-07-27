import { Prisma } from "@prisma/client";
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
  const writes: Prisma.PrismaPromise<unknown>[] = [];
  for (const edge of graph.edges) {
    const source = addressFromNode(edge.source);
    const target = addressFromNode(edge.target);
    if (!source || !target || source === target) continue;
    const sourceNode = nodes.get(edge.source);
    const targetNode = nodes.get(edge.target);
    const fingerprint = `${chain}:${source}:${target}:${edge.type}`.toLowerCase();
    const confidence = edge.strength === "definitive" || edge.strength === "strong" ? "high" : "medium";
    writes.push(
      prisma.graphEdgeRow.upsert({
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
      })
    );
  }
  // One round trip instead of one per edge. The batch still runs in order, so
  // two edges sharing a fingerprint settle to the last one as before.
  if (writes.length) await prisma.$transaction(writes);
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
  /**
   * The risk categories this run read end to end, when `findings` is everything
   * the run scored. Absence is only evidence that a signal stopped firing when
   * the list it is absent from is complete and its category was readable: for a
   * category the run could not read, absence is a gap, and closing an event on
   * it would report an outage as the risk having ended. Null when the finding
   * list was truncated, which refreshes events but resolves none.
   */
  completeCategories?: string[] | null;
}) {
  // One read for the token instead of a findFirst per finding. Rows written
  // before the dedupe existed can still be duplicated, so the oldest match wins
  // as it did before.
  const open = await prisma.riskEvent.findMany({
    where: { chain: input.chain, tokenAddress: input.tokenAddress, autoDetected: true },
    orderBy: { occurredAt: "asc" },
  });
  const byTitle = new Map<string, (typeof open)[number]>();
  for (const row of open) {
    if (!byTitle.has(row.title)) byTitle.set(row.title, row);
  }

  const reproduced = new Set<string>();
  const writes: Prisma.PrismaPromise<unknown>[] = [];

  for (const finding of input.findings.filter((f) => f.severity === "critical" || f.severity === "high")) {
    if (reproduced.has(finding.name)) continue;
    reproduced.add(finding.name);
    // An unmapped category is a gap in this table, not a licence to guess.
    const eventClass = EVENT_CLASS_BY_CATEGORY[finding.category] ?? "insufficient_evidence";
    // No time window: a token that stays flagged for the same reason used to
    // gain one identical row per day forever. The open automatic event is
    // refreshed instead so the feed keeps one row per distinct finding.
    const existing = byTitle.get(finding.name);
    if (existing) {
      // "confirmed" and "rejected" are the reviewed states. Rewriting the
      // detail or evidence underneath a reviewer's decision would leave it
      // standing on proof nobody looked at, and a degraded run that produced no
      // evidence refs would strip the proof from a confirmed event entirely.
      const reviewed = existing.manualStatus === "confirmed" || existing.manualStatus === "rejected";
      if (reviewed) {
        // A reviewed row only has its resolution cleared: the signal firing
        // again is a fact about the detector, not about the review.
        if (existing.resolvedAt) {
          writes.push(prisma.riskEvent.update({ where: { id: existing.id }, data: { resolvedAt: null } }));
        }
        continue;
      }
      writes.push(
        prisma.riskEvent.update({
          where: { id: existing.id },
          // occurredAt is left alone so it still records the first observation.
          data: { detail: finding.summary, evidenceJson: jstr(finding.evidence), eventClass, resolvedAt: null },
        })
      );
      continue;
    }
    writes.push(
      prisma.riskEvent.create({
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
      })
    );
  }

  // An event whose finding is no longer produced used to keep its original
  // detail and occurredAt on the public feed indefinitely, presenting a
  // measurement that no longer holds as current risk. The row is marked rather
  // than deleted so a reviewer's decision survives beside the lapse.
  if (input.completeCategories?.length) {
    const complete = new Set(input.completeCategories);
    // The row records the event class, not the category that produced it, and
    // several categories map onto one class, so a class may only be resolved
    // when every category that can produce it was readable this run.
    const unread = new Set<EventClass>();
    for (const [category, eventClass] of Object.entries(EVENT_CLASS_BY_CATEGORY)) {
      if (!complete.has(category)) unread.add(eventClass);
    }
    const lapsed = open.filter(
      (row) =>
        !reproduced.has(row.title) &&
        row.resolvedAt == null &&
        !unread.has(row.eventClass as EventClass)
    );
    if (lapsed.length) {
      writes.push(
        prisma.riskEvent.updateMany({
          where: { id: { in: lapsed.map((row) => row.id) } },
          data: { resolvedAt: new Date() },
        })
      );
    }
  }

  if (writes.length) await prisma.$transaction(writes);
}
