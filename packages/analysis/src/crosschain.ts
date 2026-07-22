import type {
  CrossChainLink,
  EvidenceRef,
  LinkStrength,
  RiskEventSummary,
  RiskFinding,
} from "@rugkiller/shared";
import type { BlockscoutClient } from "@rugkiller/chain";
import { shouldIgnoreForOwnership } from "@rugkiller/shared";

export interface CrossChainInput {
  arcAddress: string;
  relatedAddresses?: string[];
  arcExplorer: BlockscoutClient;
  rhExplorer: BlockscoutClient;
  rhRiskEvents?: RiskEventSummary[];
}

export interface CrossChainResult {
  links: CrossChainLink[];
  findings: RiskFinding[];
  errors: string[];
}

function link(
  strength: LinkStrength,
  fromChain: string,
  toChain: string,
  from: string,
  to: string,
  reason: string,
  evidence: EvidenceRef[],
  relatedEventIds: string[] = []
): CrossChainLink {
  return {
    id: `${strength}-${fromChain}-${from}-${toChain}-${to}`.slice(0, 120),
    strength,
    fromChain,
    toChain,
    fromAddress: from.toLowerCase(),
    toAddress: to.toLowerCase(),
    reason,
    evidence,
    relatedEventIds,
  };
}

/**
 * Enrich an Arc analysis with outside-chain creator history. Ordinary activity
 * stays internal; only reviewed events with evidence become Arc warnings.
 */
export async function compareCrossChain(input: CrossChainInput): Promise<CrossChainResult> {
  const links: CrossChainLink[] = [];
  const findings: RiskFinding[] = [];
  const errors: string[] = [];
  const addresses = [
    input.arcAddress,
    ...(input.relatedAddresses ?? []),
  ]
    .map((a) => a.toLowerCase())
    .filter((a, i, arr) => arr.indexOf(a) === i)
    .filter((a) => !shouldIgnoreForOwnership(a));

  for (const addr of addresses) {
    const relatedRiskEvents = (input.rhRiskEvents ?? []).filter(
      (event) =>
        event.chain !== "arc_testnet" &&
        event.manualStatus === "confirmed" &&
        event.eventClass !== "insufficient_evidence" &&
        event.evidence.length > 0 &&
        event.addresses.some((candidate) => candidate.toLowerCase() === addr)
    );

    if (relatedRiskEvents.length > 0) {
      findings.push({
        id: `creator-history-risk-${addr}`,
        category: "cross_chain",
        name: "Creator linked to confirmed prior risk evidence",
        severity: relatedRiskEvents.some((event) => event.eventClass === "confirmed_malicious")
          ? "critical"
          : "high",
        status: "observed",
        summary: `This Arc creator is linked to ${relatedRiskEvents.length} confirmed risk event(s) on another network.`,
        whyItMatters:
          "A reviewed history of harmful token activity can raise concern about a new Arc launch. Review the evidence; network activity alone is not the warning.",
        evidence: relatedRiskEvents.slice(0, 3).flatMap((event) => event.evidence).slice(0, 8),
        source: "automatic",
      });

      for (const event of relatedRiskEvents) {
        links.push(
          link(
            "strong",
            event.chain,
            "arc_testnet",
            addr,
            input.arcAddress,
            `Creator associated with confirmed ${event.chain} event: ${event.title}`,
            event.evidence,
            [event.id]
          )
        );
      }
    }

    // Definitive: same address exists / has activity on Robinhood
    try {
      const rhAddr = await input.rhExplorer.getAddress(addr);
      if (rhAddr) {
        const hasActivity =
          Boolean(rhAddr.creation_tx_hash) ||
          Boolean(rhAddr.coin_balance && rhAddr.coin_balance !== "0") ||
          rhAddr.is_contract;

        // Confirm with at least one tx if possible
        let txCountHint = 0;
        try {
          const txs = await input.rhExplorer.getAddressTransactions(addr);
          txCountHint = txs.items?.length ?? 0;
        } catch {
          /* optional */
        }

        if (hasActivity || txCountHint > 0) {
          const l = link(
            "definitive",
            "arc_testnet",
            "robinhood",
            addr,
            addr,
            "Same wallet address observed on both Arc and Robinhood Chain.",
            [
              { type: "address", chain: "arc_testnet", value: addr, label: "Arc address" },
              {
                type: "address",
                chain: "robinhood",
                value: addr,
                label: "Robinhood address",
                url: `https://robinhoodchain.blockscout.com/address/${addr}`,
              },
            ]
          );
          links.push(l);

        }
      }
    } catch (e) {
      errors.push(`rh address ${addr}: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Keep deployments as internal identity evidence. Deployment on another
    // chain is not a risk signal by itself and must never be shown as one.
    try {
      const txs = await input.rhExplorer.getAddressTransactions(addr);
      const deploys = (txs.items ?? []).filter((t) => t.created_contract?.hash);
      if (deploys.length) {
        links.push(
          link(
            "definitive",
            "robinhood",
            "arc_testnet",
            addr,
            addr,
            `Address deployed ${deploys.length} contract(s) on Robinhood Chain (recent page).`,
            deploys.slice(0, 5).map(
              (t): EvidenceRef => ({
                type: "tx",
                chain: "robinhood",
                value: t.hash,
                label: t.created_contract?.hash,
                url: `https://robinhoodchain.blockscout.com/tx/${t.hash}`,
              })
            )
          )
        );
      }
    } catch {
      /* optional */
    }
  }

  // Funding path: Arc first funder equals RH risky address (if provided in related)
  // (Worker layer supplies risk event addresses into relatedAddresses / rhRiskEvents)

  return { links, findings, errors };
}
