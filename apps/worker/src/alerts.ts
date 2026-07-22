import { prisma, jparse, jstr } from "@rugkiller/db";

export async function runAlertEngine() {
  const watches = await prisma.watchlistItem.findMany({ take: 500 });
  if (!watches.length) return;

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
          dedupeKey: `risk-${w.userId}-${w.address}-${token.overallRisk}-${token.analysisUpdatedAt?.toISOString() ?? ""}`,
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
          dedupeKey: `sellfail-${w.userId}-${w.address}-${sim.id}`,
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
      const events = await prisma.riskEvent.findMany({
        where: { createdAt: { gte: new Date(Date.now() - 6 * 3600 * 1000) } },
        take: 50,
      });
      for (const e of events) {
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
  } catch {
    // unique dedupeKey
  }
}
