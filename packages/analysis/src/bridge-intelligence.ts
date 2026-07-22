import type { EvidenceRef } from "@rugkiller/shared";

export type ArcInboundTransferStatus =
  | "source_burn_observed"
  | "circle_attested"
  | "arc_mint_confirmed"
  | "unresolved"
  | "wrong_destination";

export interface ArcInboundTransferObservation {
  sourceChain: string;
  sourceTxHash: string;
  sourceWallet: string;
  arcRecipient: string;
  amountUsdc: string;
  destinationDomain: number;
  burnObservedAt: string;
  attestationHash?: string | null;
  arcMintTxHash?: string | null;
  arcMintObservedAt?: string | null;
  sourceExplorerUrl?: string;
  arcExplorerUrl?: string;
}

export interface ArcInboundTransferAssessment {
  status: ArcInboundTransferStatus;
  completed: boolean;
  summary: string;
  evidence: EvidenceRef[];
}

export const ARC_CCTP_DOMAIN = 26;
const DEFAULT_UNRESOLVED_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * Evidence-first CCTP state machine. A source-chain USDC burn is never called
 * an Arc bridge completion until an Arc mint transaction is independently
 * observed. Source networks are inputs only; the product subject is Arc.
 */
export function assessArcInboundTransfer(
  observation: ArcInboundTransferObservation,
  options: { now?: Date; unresolvedAfterMs?: number } = {}
): ArcInboundTransferAssessment {
  const evidence: EvidenceRef[] = [
    {
      type: "tx",
      chain: observation.sourceChain,
      value: observation.sourceTxHash,
      label: "CCTP source burn",
      url: observation.sourceExplorerUrl,
    },
    {
      type: "address",
      chain: "arc_testnet",
      value: observation.arcRecipient.toLowerCase(),
      label: "Intended Arc recipient",
    },
  ];

  if (observation.destinationDomain !== ARC_CCTP_DOMAIN) {
    return {
      status: "wrong_destination",
      completed: false,
      summary: `The burn targets CCTP domain ${observation.destinationDomain}, not Arc domain ${ARC_CCTP_DOMAIN}.`,
      evidence,
    };
  }

  if (observation.arcMintTxHash) {
    evidence.push({
      type: "tx",
      chain: "arc_testnet",
      value: observation.arcMintTxHash,
      label: "Arc destination mint",
      url: observation.arcExplorerUrl,
    });
    return {
      status: "arc_mint_confirmed",
      completed: true,
      summary: `${observation.amountUsdc} USDC source burn and Arc destination mint were both observed.`,
      evidence,
    };
  }

  if (observation.attestationHash) {
    evidence.push({
      type: "external",
      chain: "circle_cctp",
      value: observation.attestationHash,
      label: "Circle attestation",
    });
    return {
      status: "circle_attested",
      completed: false,
      summary: "Circle attestation is available, but no Arc destination mint has been observed yet.",
      evidence,
    };
  }

  const now = options.now ?? new Date();
  const ageMs = now.getTime() - new Date(observation.burnObservedAt).getTime();
  const unresolvedAfterMs = options.unresolvedAfterMs ?? DEFAULT_UNRESOLVED_AFTER_MS;
  if (Number.isFinite(ageMs) && ageMs >= unresolvedAfterMs) {
    return {
      status: "unresolved",
      completed: false,
      summary: "A source USDC burn was observed, but no Circle attestation or Arc mint was found within the expected window.",
      evidence,
    };
  }

  return {
    status: "source_burn_observed",
    completed: false,
    summary: "A source USDC burn targeting Arc was observed. Settlement is not yet confirmed.",
    evidence,
  };
}
