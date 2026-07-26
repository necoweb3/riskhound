import { PrismaClient } from "@prisma/client";
const p = new PrismaClient({ log: [{emit:"event",level:"query"}] });
p.$on("query", (e) => console.log("SQL:", e.query, "PARAMS:", e.params));
const where = {
  chain: "arc_observed_5042",
  AND: [
    { NOT: { name: { startsWith: "qa_" } } },
    { NOT: { symbol: { startsWith: "qa_" } } },
  ],
};
try {
  console.log("count", await p.token.count({ where }));
} catch (e) { console.log("ERR", String(e.message).slice(0,400)); }
await p.$disconnect();
