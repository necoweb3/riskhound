import { prisma, jparse, jstr } from "@rugkiller/db";

const WATCH_PAGE = 500;

export async function runAlertEngine() {
  // The same recent risk events apply to every watched wallet, so read them
  // once and in a deterministic order instead of per watchlist row.
  const recentEvents = await prisma.riskEvent.findMany({
    where: { createdAt: { gte: new Date(Date.now() - 6 * 3600 * 1000) } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  // Page through the whole watchlist. A bare take() with no ordering silently
  // stopped alerting for every user past the first page.
  let watchCursor: string | undefined;
  for (;;) {
    const watches = await prisma.watchlistItem.findMany({
      orderBy: { id: "asc" },
      take: WATCH_PAGE,
      ...(watchCursor ? { skip: 1, cursor: { id: watchCursor } } : {}),
    });
    if (!watches.length) return;
    await processWatches(watches, recentEvents);
    if (watches.length < WATCH_PAGE) return;
    watchCursor = watches[watches.length - 1].id;
  }
}

type Watch = { userId: string; entityType: string; chain: string; address: string };
type RecentEvent = {
  id: string;
  eventClass: string;
  title: string;
  detail: string | null;
  addressesJson: string;
  evidenceJson: string;
};

async function processWatches(watches: Watch[], recentEvents: RecentEvent[]) {
  for (const w of watches) {
    if (w.entityType === "token") {
      const token = await prisma.token.findUnique({
        where: { chain_address: { chain: w.chain, address: w.address } },
        include: {
          simulations: { orderBy: { createdAt: "desc" }, take: 2 },
          analyses: { orderBy: { createdAt: "desc" }, take: 2 },
        },
      });
      if (!token) continue;

      if (token.overallRisk === "critical_risk" || token.overallRisk === "high_risk") {
        await emit({
          userId: w.userId,
          entityType: "token",
          chain: w.chain,
          address: w.address,
          type: "risk_elevated",
          severity: token.overallRisk === "critical_risk" ? "critical" : "high",
          title: `Risk elevated: ${token.symbol ?? token.address.slice(0, 10)}`,
          body: `Overall risk is ${token.overallRisk}. Signals: ${jparse<string[]>(token.topSignalsJson, []).join(", ")}`,
          evidence: [{ type: "contract", chain: w.chain, value: w.address }],
          // Keyed on the risk state only. Including the analysis timestamp made
          // every re-analysis of an unchanged token fire the alert again.
          dedupeKey: `risk-${w.userId}-${w.address}-${token.overallRisk}`,
        });
      }

      const sim = token.simulations[0];
      if (sim && sim.canSell === false && sim.canBuy === true) {
        await emit({
          userId: w.userId,
          entityType: "token",
          chain: w.chain,
          address: w.address,
          type: "sell_sim_failed",
          severity: "critical",
          title: "Sell simulation failed",
          body: sim.summary,
          evidence: [{ type: "simulation", chain: w.chain, value: sim.id }],
          // The simulation id changes on every re-run, so key on the state it
          // reports instead. The id stays in the evidence for the audit trail.
          dedupeKey: `sellfail-${w.userId}-${w.address}-cannot-sell`,
        });
      }

      if (token.hasRobinhoodLink) {
        await emit({
          userId: w.userId,
          entityType: "token",
          chain: w.chain,
          address: w.address,
          type: "creator_history_warning",
          severity: "high",
          title: "Concerning creator history found",
          body: "Reviewed evidence links this Arc token creator to a prior risk event on another network.",
          evidence: [{ type: "contract", chain: w.chain, value: w.address }],
          dedupeKey: `creator-history-${w.userId}-${w.address}-v2`,
        });
      }
    }

    if (w.entityType === "wallet") {
      for (const e of recentEvents) {
        const addrs = jparse<string[]>(e.addressesJson, []).map((x) => x.toLowerCase());
        if (!addrs.includes(w.address.toLowerCase())) continue;
        await emit({
          userId: w.userId,
          entityType: "wallet",
          chain: w.chain,
          address: w.address,
          type: "wallet_risk_event",
          severity: e.eventClass === "confirmed_malicious" ? "critical" : "high",
          title: e.title,
          body: e.detail ?? e.eventClass,
          evidence: jparse(e.evidenceJson, []),
          dedupeKey: `wevt-${w.userId}-${e.id}`,
        });
      }
    }
  }
}

async function emit(a: {
  userId: string;
  entityType: string;
  chain: string;
  address: string;
  type: string;
  severity: string;
  title: string;
  body: string;
  evidence: object[];
  dedupeKey: string;
}) {
  try {
    await prisma.alert.create({
      data: {
        userId: a.userId,
        entityType: a.entityType,
        chain: a.chain,
        address: a.address,
        type: a.type,
        severity: a.severity,
        title: a.title,
        body: a.body,
        evidenceJson: jstr(a.evidence),
        dedupeKey: a.dedupeKey,
      },
    });
  } catch (e) {
    // P2002 is the dedupeKey collision this relies on. Anything else is a real
    // write failure and must be visible rather than dropped.
    if ((e as { code?: string })?.code === "P2002") return;
    console.error("[alerts] emit failed", a.dedupeKey, e instanceof Error ? e.message : e);
  }
}
