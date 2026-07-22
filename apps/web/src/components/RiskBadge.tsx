import { riskClass, riskLabel } from "@/lib/api";

export function RiskBadge({ risk }: { risk: string | null | undefined }) {
  return (
    <span className={riskClass(risk)} title={riskLabel(risk)}>
      {riskLabel(risk)}
    </span>
  );
}
