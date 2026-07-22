import { loadRootEnv } from "./env.js";
loadRootEnv();

import { PrismaClient } from "@prisma/client";
import { jparse, jstr } from "./json.js";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export * from "@prisma/client";
export { prisma as db };
export { jparse, jstr };
export { loadRootEnv };
export { persistEvidenceGraph, persistAutomaticRiskEvents } from "./evidence.js";
