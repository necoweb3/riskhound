/**
 * Remove bare contract stubs that are not real tokens.
 * Usage from repo root: node scripts/cleanup-junk-tokens.mjs
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync, existsSync } from "node:fs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(root, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const absDb = resolve(root, "packages/db/prisma/dev.db").replace(/\\/g, "/");
process.env.DATABASE_URL = `file:${absDb}`;

// Import workspace db package (loads prisma)
const { prisma } = await import(pathToFileURL(resolve(root, "packages/db/src/index.ts")).href).catch(
  async () => {
    // fallback: run via tsx style dynamic from built path
    const { PrismaClient } = await import(
      pathToFileURL(
        resolve(
          root,
          "node_modules/.pnpm/@prisma+client@6.19.3_prisma@6.19.3_typescript@5.9.3__typescript@5.9.3/node_modules/@prisma/client/index.js"
        )
      ).href
    );
    return { prisma: new PrismaClient() };
  }
);

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

console.log(`Found ${junk.length} junk stubs`);
if (junk.length) {
  const res = await prisma.token.deleteMany({
    where: { id: { in: junk.map((j) => j.id) } },
  });
  console.log(`Deleted ${res.count}`);
}

await prisma.$disconnect();
