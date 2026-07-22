/**
 * One-shot local setup: ensure .env, generate Prisma client, push schema.
 * Usage: node scripts/setup.mjs
 */
import { existsSync, copyFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(root, ".env");
const envExample = resolve(root, ".env.example");

function run(cmd, args, cwd = root, env = process.env) {
  console.log(`> ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, {
    cwd,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

console.log("RiskHound setup\n");

if (!existsSync(envPath)) {
  if (existsSync(envExample)) {
    copyFileSync(envExample, envPath);
    console.log("Created .env from .env.example");
  } else {
    console.error("Missing .env and .env.example");
    process.exit(1);
  }
} else {
  console.log(".env already present");
}

// Ensure absolute SQLite path for Windows reliability
const dbFile = resolve(root, "packages/db/prisma/dev.db");
mkdirSync(dirname(dbFile), { recursive: true });
const absDb = `file:${dbFile.replace(/\\/g, "/")}`;

const env = {
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL?.startsWith("file:")
    ? absDb
    : process.env.DATABASE_URL || absDb,
  REDIS_OPTIONAL: process.env.REDIS_OPTIONAL ?? "true",
};

// Write absolute DATABASE_URL into env for prisma if still relative
if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes("file:./")) {
  env.DATABASE_URL = absDb;
}

console.log(`DATABASE_URL=${env.DATABASE_URL}`);

const dbPkg = resolve(root, "packages/db");

// generate may EPERM on Windows if API/worker lock the query engine DLL
const gen = spawnSync("pnpm", ["exec", "prisma", "generate"], {
  cwd: dbPkg,
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (gen.status !== 0) {
  console.warn(
    "prisma generate failed (often file lock while API/worker run). Continuing if DB is already set up."
  );
}

const push = spawnSync("pnpm", ["exec", "prisma", "db", "push", "--skip-generate"], {
  cwd: dbPkg,
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (push.status !== 0) {
  console.error("prisma db push failed");
  process.exit(push.status ?? 1);
}

console.log("\nSetup complete.");
console.log("Start with:");
console.log("  pnpm dev:api");
console.log("  pnpm dev:worker");
console.log("  pnpm dev:web");
console.log("Or:  .\\scripts\\dev.ps1");
