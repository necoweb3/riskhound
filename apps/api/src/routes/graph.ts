import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma, jparse } from "@rugkiller/db";
import { normalizeAddress } from "@rugkiller/chain";

const MAX_DEPTH = 3;
const MAX_VISITED = 120;
const MAX_EDGES_PER_NODE = 40;

export async function graphRoutes(app: FastifyInstance) {
  app.get("/graph/path", async (req, reply) => {
    const q = z.object({
      from: z.string(),
      to: z.string(),
      chain: z.string().default("arc_testnet"),
      maxDepth: z.coerce.number().int().min(1).max(MAX_DEPTH).default(MAX_DEPTH),
    }).parse(req.query);
    const from = normalizeAddress(q.from)?.toLowerCase();
    const to = normalizeAddress(q.to)?.toLowerCase();
    if (!from || !to) return reply.code(400).send({ error: "invalid_address" });
    if (from === to) return { found: true, depth: 0, nodes: [from], edges: [] };

    type StoredEdge = Awaited<ReturnType<typeof prisma.graphEdgeRow.findMany>>[number];
    const queue: { address: string; nodes: string[]; edges: StoredEdge[] }[] = [
      { address: from, nodes: [from], edges: [] },
    ];
    const visited = new Set([from]);
    while (queue.length && visited.size <= MAX_VISITED) {
      const current = queue.shift()!;
      if (current.edges.length >= q.maxDepth) continue;
      const rows = await prisma.graphEdgeRow.findMany({
        where: {
          chain: q.chain,
          serviceExcluded: false,
          OR: [{ sourceId: current.address }, { targetId: current.address }],
        },
        take: MAX_EDGES_PER_NODE,
        orderBy: { createdAt: "desc" },
      });
      for (const edge of rows) {
        const next = edge.sourceId === current.address ? edge.targetId : edge.sourceId;
        if (visited.has(next)) continue;
        const nodes = [...current.nodes, next];
        const edges = [...current.edges, edge];
        if (next === to) {
          return {
            schemaVersion: "rugkiller.graph-path.v1",
            found: true,
            depth: edges.length,
            nodes,
            edges: edges.map((e) => ({
              id: e.id,
              source: e.sourceId,
              target: e.targetId,
              type: e.edgeType,
              strength: e.strength,
              confidence: e.confidence,
              evidence: jparse(e.evidenceJson, []),
              label: e.label,
            })),
            confidence: edges.every((e) => e.confidence === "high") ? "high" : "medium",
            limits: { maxDepth: q.maxDepth, maxVisited: MAX_VISITED },
          };
        }
        visited.add(next);
        queue.push({ address: next, nodes, edges });
      }
    }
    return {
      schemaVersion: "rugkiller.graph-path.v1",
      found: false,
      depth: null,
      nodes: [],
      edges: [],
      confidence: "low",
      limits: { maxDepth: q.maxDepth, maxVisited: MAX_VISITED },
      note: "No path was found in the bounded evidence graph; this is not proof that no connection exists.",
    };
  });
}
