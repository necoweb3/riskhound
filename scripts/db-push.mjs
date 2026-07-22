import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dbPkg = resolve(root, "packages/db");

// Load root .env lightly
const envPath = resolve(root, ".env");
const env = { ...process.env };
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (env[k] === undefined) env[k] = v;
  }
}

// Prefer absolute sqlite path
const absDb = resolve(root, "packages/db/prisma/dev.db").replace(/\\/g, "/");
if (!env.DATABASE_URL || env.DATABASE_URL.startsWith("file:./") || env.DATABASE_URL.includes("file:./dev.db")) {
  env.DATABASE_URL = `file:${absDb}`;
}

console.log("DATABASE_URL=", env.DATABASE_URL);
const r = spawnSync("pnpm", ["exec", "prisma", "db", "push"], {
  cwd: dbPkg,
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(r.status ?? 1);
