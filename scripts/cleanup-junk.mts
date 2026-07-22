import { prisma } from "../packages/db/src/index.ts";

const junk = await prisma.token.findMany({
  where: {
    chain: "arc_testnet",
    name: null,
    symbol: null,
    analysisUpdatedAt: null,
    standard: "unknown",
  },
  select: { id: true },
});

console.log("junk", junk.length);
if (junk.length) {
  const r = await prisma.token.deleteMany({
    where: { id: { in: junk.map((j) => j.id) } },
  });
  console.log("deleted", r.count);
}

const sample = await prisma.token.findMany({
  take: 8,
  orderBy: [{ analysisUpdatedAt: "desc" }, { createdAt: "desc" }],
  where: {
    OR: [{ name: { not: null } }, { analysisUpdatedAt: { not: null } }, { standard: "ERC-20" }],
  },
});

console.log(
  sample.map((t) => ({
    name: t.name,
    symbol: t.symbol,
    risk: t.overallRisk,
    addr: t.address.slice(0, 12),
  }))
);

await prisma.$disconnect();
