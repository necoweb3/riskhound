import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "packages/db/prisma/schema.prisma");
const destination = resolve(root, "packages/db/prisma/postgres/schema.prisma");
const original = readFileSync(source, "utf8");
const schema = original.replace('provider = "sqlite"', 'provider = "postgresql"');

if (schema === original) throw new Error("SQLite datasource declaration was not found");
mkdirSync(dirname(destination), { recursive: true });
writeFileSync(destination, `// Generated from ../schema.prisma. Do not edit directly.\n${schema}`);
console.log(`Generated ${destination}`);
