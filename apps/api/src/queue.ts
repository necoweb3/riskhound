import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { config } from "./config.js";

let connection: Redis | null = null;
let analysisQueue: Queue | null = null;
let redisAvailable = false;

const redisOptional = process.env.REDIS_OPTIONAL !== "false";

export function isRedisUp() {
  return redisAvailable;
}

/**
 * Connect Redis once. When REDIS_OPTIONAL is not "false", failure is non-fatal
 * and the client is discarded so it cannot spam reconnection errors.
 */
export async function initQueues(): Promise<boolean> {
  if (redisAvailable && analysisQueue) return true;

  let client: Redis | null = null;
  try {
    client = new Redis(config.redisUrl, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
      enableOfflineQueue: false,
      connectTimeout: 1500,
      retryStrategy: () => null,
    });
    // swallow errors while probing
    client.on("error", () => undefined);

    await client.connect();
    const pong = await client.ping();
    if (pong !== "PONG") throw new Error("unexpected ping response");

    connection = client;
    analysisQueue = new Queue("token-analysis", {
      connection: client,
      defaultJobOptions: {
        removeOnComplete: 200,
        removeOnFail: 500,
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
      },
    });
    redisAvailable = true;
    console.log("[queue] Redis connected");
    return true;
  } catch (e) {
    try {
      client?.disconnect();
    } catch {
      /* ignore */
    }
    connection = null;
    analysisQueue = null;
    redisAvailable = false;

    const msg = e instanceof Error ? e.message : String(e);
    if (redisOptional) {
      console.warn(`[queue] Redis offline (${msg}). Running without job queue.`);
      return false;
    }
    throw new Error(`Redis required but unavailable: ${msg}`);
  }
}

export async function enqueueAnalysis(address: string, force?: boolean) {
  if (!analysisQueue || !redisAvailable) {
    return { queued: false as const, reason: "redis_unavailable" as const };
  }
  await analysisQueue.add(
    "analyze",
    { address: address.toLowerCase(), chain: "arc_testnet", force },
    { jobId: `analyze-${address.toLowerCase()}-${Date.now()}` }
  );
  return { queued: true as const };
}
