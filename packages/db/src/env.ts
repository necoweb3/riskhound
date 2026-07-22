import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

/**
 * Load monorepo-root .env into process.env if keys are missing.
 * Works without dotenv dependency.
 */
export function loadRootEnv() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "../../../.env"),
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../../.env"),
  ];

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
    break;
  }

  // Normalize SQLite relative paths to absolute (prisma schema dir)
  const db = process.env.DATABASE_URL;
  if (db?.startsWith("file:./") || db?.startsWith("file:../")) {
    const schemaDir = resolve(here, "../prisma");
    const rel = db.replace(/^file:/, "");
    const abs = resolve(schemaDir, rel);
    process.env.DATABASE_URL = `file:${abs.replace(/\\/g, "/")}`;
  }
}
