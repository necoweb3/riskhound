import { Worker, Queue } from "bullmq";
import { Redis } from "ioredis";
import { prisma } from "@rugkiller/db";
import { runArcDiscovery } from "./arcDiscovery.js";
import { runRobinhoodIndexer } from "./robinhoodIndexer.js";
import { runAlertEngine } from "./alerts.js";
import { loadRhAndAnalyze } from "./analyzeJob.js";
import { runBridgeIndexer } from "./bridgeIndexer.js";
import { runObservedMainnetIndexer } from "./observedMainnetIndexer.js";
import { runBridgeSettlementIndexer } from "./bridgeSettlementIndexer.js";
import { runSolanaCctpIndexer } from "./solanaCctpIndexer.js";
import { runEvmCctpBackfill } from "./evmCctpBackfill.js";
import { runObservedArcHolderIndexer } from "./observedArcHolderIndexer.js";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const redisOptional = process.env.REDIS_OPTIONAL !== "false";

// Empty or unparsable env values turn Number() into 0 or NaN, which would run a
// poll loop with no delay at all against the RPC and the database.
const MIN_POLL_MS = 5_000;
function pollMs(raw: string | undefined, fallback: number) {
  const parsed = Number(raw);
  if (!raw?.trim() || !Number.isFinite(parsed)) return fallback;
  return Math.max(MIN_POLL_MS, parsed);
}

async function loop(name: string, ms: number, fn: () => Promise<void>) {
  const run = async () => {
    try {
      await fn();
    } catch (e) {
      console.error(`[${name}]`, e instanceof Error ? e.message : e);
    } finally {
      setTimeout(run, ms);
    }
  };
  void run();
}

async function tryRedis(): Promise<{
  connection: Redis;
  analysisQueue: Queue;
} | null> {
  let client: Redis | null = null;
  try {
    client = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
      enableOfflineQueue: false,
      connectTimeout: 1500,
      retryStrategy: () => null,
    });
    client.on("error", () => undefined);
    await client.connect();
    await client.ping();
    const analysisQueue = new Queue("token-analysis", { connection: client });
    console.log("[worker] Redis connected");
    return { connection: client, analysisQueue };
  } catch (e) {
    try {
      client?.disconnect();
    } catch {
      /* ignore */
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (redisOptional) {
      console.warn(`[worker] Redis offline (${msg}). Using inline analysis.`);
      return null;
    }
    throw e;
  }
}

async function main() {
  console.log("RiskHound worker starting…");
  await prisma.$queryRaw`SELECT 1`;
  console.log("[worker] Database OK");

  const redis = await tryRedis();
  let analysisQueue: Queue | null = redis?.analysisQueue ?? null;

  if (redis) {
    const concurrency = Number(process.env.ANALYSIS_CONCURRENCY ?? 3);
    const worker = new Worker(
      "token-analysis",
      async (job) => {
        const address = String(job.data.address).toLowerCase();
        console.log(`[analysis] ${address}`);
        const result = await loadRhAndAnalyze(address);
        return { tokenId: result.tokenId, overall: result.overall };
      },
      { connection: redis.connection, concurrency }
    );
    worker.on("failed", (job, err) => {
      console.error(`[analysis] failed ${job?.id}`, err.message);
    });
    // Without an 'error' listener an EventEmitter rethrows, so any Redis-side
    // error would take the whole worker process down.
    worker.on("error", (err) => {
      console.error("[analysis] worker error", err instanceof Error ? err.message : err);
    });
    redis.analysisQueue.on("error", (err) => {
      console.error("[analysis] queue error", err instanceof Error ? err.message : err);
    });
  }

  const arcPoll = pollMs(process.env.ARC_INDEXER_POLL_MS, 60_000);
  const rhPoll = pollMs(process.env.ROBINHOOD_INDEXER_POLL_MS, 120_000);
  const bridgePoll = pollMs(process.env.BRIDGE_INDEXER_POLL_MS, 60_000);
  const observedMainnetPoll = pollMs(process.env.OBSERVED_MAINNET_INDEXER_POLL_MS, 300_000);
  const settlementPoll = pollMs(process.env.BRIDGE_SETTLEMENT_POLL_MS, 60_000);
  const solanaCctpPoll = pollMs(process.env.SOLANA_CCTP_POLL_MS, 120_000);
  const evmCctpBackfillPoll = pollMs(process.env.EVM_CCTP_BACKFILL_POLL_MS, 300_000);

  await loop("arc-discovery", arcPoll, async () => {
    const found = await runArcDiscovery();
    for (const addr of found) {
      if (analysisQueue) {
        await analysisQueue
          .add(
            "analyze",
            { address: addr, chain: "arc_testnet" },
            {
              jobId: `recent-${addr}-${Math.floor(Date.now() / 3_600_000)}`,
              attempts: 3,
              backoff: { type: "exponential", delay: 10_000 },
              removeOnComplete: true,
              removeOnFail: { age: 3_600, count: 1_000 },
            }
          )
          .catch(() => undefined);
      } else {
        try {
          await loadRhAndAnalyze(addr);
        } catch (e) {
          console.error("[inline-analyze]", addr, e instanceof Error ? e.message : e);
        }
      }
    }
  });

  await loop("analysis-backfill", 60_000, async () => {
    const batchSize = Math.max(1, Math.min(50, Number(process.env.ANALYSIS_BACKFILL_BATCH ?? 20)));
    // The pending count has to use the same filter as the batch query, or it
    // reports a backlog the backfill will never pick up and never drains.
    const [pending, analyzed, batch] = await Promise.all([
      prisma.token.count({
        where: {
          chain: "arc_testnet",
          analysisUpdatedAt: null,
          OR: [{ name: { not: null } }, { symbol: { not: null } }],
        },
      }),
      prisma.token.count({ where: { chain: "arc_testnet", analysisUpdatedAt: { not: null } } }),
      prisma.token.findMany({
        where: {
          chain: "arc_testnet",
          analysisUpdatedAt: null,
          OR: [{ name: { not: null } }, { symbol: { not: null } }],
        },
        orderBy: [{ holderCount: "desc" }, { createdAt: "desc" }],
        take: batchSize,
        select: { address: true },
      }),
    ]);
    const hourBucket = Math.floor(Date.now() / 3_600_000);
    if (analysisQueue) {
      for (const token of batch) {
        await analysisQueue.add(
          "analyze-backfill",
          { address: token.address, chain: "arc_testnet" },
          {
            jobId: `backfill-${token.address}-${hourBucket}`,
            attempts: 3,
            backoff: { type: "exponential", delay: 15_000 },
            removeOnComplete: true,
            removeOnFail: { age: 3_600, count: 1_000 },
          }
        ).catch(() => undefined);
      }
    } else {
      // Per token error handling so one token that always fails does not hold
      // up the rest of the backlog forever.
      for (const token of batch) {
        try {
          await loadRhAndAnalyze(token.address);
        } catch (e) {
          console.error("[analysis-backfill]", token.address, e instanceof Error ? e.message : e);
        }
      }
    }
    await prisma.dataSourceHealth.upsert({
      where: { key: "analysis_backlog" },
      create: {
        key: "analysis_backlog",
        name: "Arc token analysis backlog",
        healthy: true,
        lastSuccessAt: new Date(),
        metaJson: JSON.stringify({ pending, analyzed, scheduled: batch.length }),
      },
      update: {
        healthy: true,
        lastSuccessAt: new Date(),
        lastError: null,
        metaJson: JSON.stringify({ pending, analyzed, scheduled: batch.length }),
      },
    });
  });

  await loop("rh-indexer", rhPoll, async () => {
    await runRobinhoodIndexer();
  });

  await loop("bridge-indexer", bridgePoll, async () => {
    await runBridgeIndexer();
  });

  await loop("observed-mainnet-indexer", observedMainnetPoll, async () => {
    await runObservedMainnetIndexer();
  });

  await loop("bridge-settlement-indexer", settlementPoll, async () => {
    await runBridgeSettlementIndexer();
  });

  await loop("solana-cctp-indexer", solanaCctpPoll, async () => {
    await runSolanaCctpIndexer();
  });

  await loop("evm-cctp-backfill", evmCctpBackfillPoll, async () => {
    await runEvmCctpBackfill();
  });

  // Chain 5042 has no explorer, so holders and creators are rebuilt from the
  // node instead. Slow on purpose: it is a backfill, not a live feed.
  await loop("observed-arc-holders", pollMs(process.env.OBSERVED_ARC_HOLDER_POLL_MS, 120_000), async () => {
    await runObservedArcHolderIndexer();
  });

  await loop("alerts", 20_000, async () => {
    await runAlertEngine();
  });

  await loop("heartbeat", 30_000, async () => {
    await prisma.dataSourceHealth.upsert({
      where: { key: "worker" },
      create: {
        key: "worker",
        name: "RiskHound Worker",
        healthy: true,
        lastSuccessAt: new Date(),
      },
      update: { name: "RiskHound Worker", healthy: true, lastSuccessAt: new Date(), lastError: null },
    });
  });

  console.log(
    `Workers running (arc discovery, observed mainnet inventory, CCTP sources and settlement, robinhood indexer, alerts${analysisQueue ? ", queue" : ", inline"})`
  );
}

// Node aborts the process on an unhandled rejection by default, which would
// take every indexer loop down with whichever background promise rejected.
process.on("unhandledRejection", (reason) => {
  console.error("[worker] unhandled rejection", reason instanceof Error ? reason.message : reason);
});

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
