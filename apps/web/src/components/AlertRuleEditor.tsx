"use client";

import { useMemo, useState } from "react";

type MetricKey = "top10" | "liquidity" | "score" | "creator";
type Op = "above" | "below" | "changes";

const METRICS: Record<MetricKey, { label: string; unit: string; min: number; max: number }> = {
  top10: { label: "Top 10 holder share", unit: "%", min: 10, max: 95 },
  liquidity: { label: "Pool liquidity", unit: "%", min: 5, max: 90 },
  score: { label: "Risk score", unit: "", min: 10, max: 100 },
  creator: { label: "Creator deployments in 7 days", unit: "", min: 1, max: 20 },
};

const OPS: { key: Op; label: string }[] = [
  { key: "above", label: "rises above" },
  { key: "below", label: "falls below" },
  { key: "changes", label: "changes at all" },
];

// Only channels something can actually deliver on belong here. Nothing in the
// API or the worker sends mail or posts a webhook, so offering them would
// promise a notification that can never fire.
const CHANNELS = { app: "In app" } as const;
type ChannelKey = keyof typeof CHANNELS;

export type AlertRule = {
  metric: MetricKey;
  op: Op;
  value: number;
  channels: ChannelKey[];
};

/**
 * Alert rule builder for the watchlist. Purely local state; call `onArm` with
 * the finished rule and persist it however the API prefers.
 */
export function AlertRuleEditor({ onArm }: { onArm?: (rule: AlertRule) => void }) {
  const [metric, setMetric] = useState<MetricKey>("top10");
  const [op, setOp] = useState<Op>("above");
  const [value, setValue] = useState(70);
  const [channels, setChannels] = useState<Record<ChannelKey, boolean>>({ app: true });

  const m = METRICS[metric];

  const preview = useMemo(() => {
    const active = (Object.keys(CHANNELS) as ChannelKey[])
      .filter((k) => channels[k])
      .map((k) => CHANNELS[k].toLowerCase());
    const chText =
      active.length === 0
        ? "no channel yet"
        : active.length === 1
          ? active[0]
          : `${active.slice(0, -1).join(", ")} and ${active[active.length - 1]}`;
    const opText =
      op === "changes" ? "changes at all" : `${op === "above" ? "rises above" : "falls below"} ${value}${m.unit}`;
    return `Alert me when ${m.label.toLowerCase()} ${opText} on any watched token, via ${chText}.`;
  }, [channels, op, value, m]);

  return (
    <section className="rk-reveal rk-card" style={{ padding: 0, overflow: "hidden", marginTop: 16 }}>
      <div className="rk-panel-head">
        <span>New alert rule</span>
        <span style={{ color: "var(--text-4)" }}>Evaluated every indexer pass</span>
      </div>

      <div style={{ padding: "18px 16px", display: "flex", flexDirection: "column", gap: 18 }}>
        <div>
          <div className="rk-field-label">Watch this</div>
          <div className="rk-filters">
            {(Object.keys(METRICS) as MetricKey[]).map((k) => (
              <button
                key={k}
                type="button"
                className={k === metric ? "is-active" : undefined}
                onClick={() => {
                  setMetric(k);
                  setValue((v) => Math.min(Math.max(v, METRICS[k].min), METRICS[k].max));
                }}
              >
                {METRICS[k].label}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 18 }}>
          <div>
            <div className="rk-field-label">Condition</div>
            <div className="rk-filters">
              {OPS.map((o) => (
                <button
                  key={o.key}
                  type="button"
                  className={o.key === op ? "is-active" : undefined}
                  onClick={() => setOp(o.key)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          {op !== "changes" && (
            <div>
              <div className="rk-field-label">Threshold</div>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <input
                  type="range"
                  min={m.min}
                  max={m.max}
                  value={value}
                  onChange={(e) => setValue(Number(e.target.value))}
                  aria-label="Threshold"
                  style={{ flex: 1, minWidth: 0, accentColor: "var(--blue)", cursor: "pointer" }}
                />
                <span
                  style={{
                    minWidth: 62,
                    textAlign: "right",
                    fontFamily: "var(--font-mono)",
                    fontSize: 17,
                    fontWeight: 500,
                    fontVariantNumeric: "tabular-nums",
                    letterSpacing: "-0.02em",
                  }}
                >
                  {value}
                  <span style={{ fontSize: 11, color: "var(--text-3)" }}>{m.unit}</span>
                </span>
              </div>
            </div>
          )}
        </div>

        <div>
          <div className="rk-field-label">Notify through</div>
          <div className="rk-row">
            {(Object.keys(CHANNELS) as ChannelKey[]).map((k) => {
              const on = channels[k];
              return (
                <button
                  key={k}
                  type="button"
                  className="rk-btn"
                  aria-pressed={on}
                  onClick={() => setChannels((c) => ({ ...c, [k]: !c[k] }))}
                  style={{
                    gap: 8,
                    borderColor: on ? "var(--blue)" : "var(--line-2)",
                    background: on ? "color-mix(in srgb, var(--blue) 12%, var(--surface))" : "var(--surface)",
                    color: on ? "var(--text)" : "var(--text-3)",
                  }}
                >
                  <i
                    style={{
                      width: 14,
                      height: 14,
                      display: "grid",
                      placeItems: "center",
                      border: `1px solid ${on ? "var(--blue)" : "var(--line-2)"}`,
                      borderRadius: 3,
                      fontSize: 9,
                      fontWeight: 700,
                      fontStyle: "normal",
                      lineHeight: 1,
                    }}
                  >
                    {on ? "\u2713" : ""}
                  </i>
                  {CHANNELS[k]}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
          padding: "14px 16px",
          borderTop: "1px solid var(--line)",
          background: "var(--surface-2)",
        }}
      >
        <p style={{ margin: 0, maxWidth: "66ch", fontSize: 13, lineHeight: 1.5, color: "var(--text-2)" }}>{preview}</p>
        <button
          type="button"
          className="rk-btn rk-btn--primary"
          onClick={() =>
            onArm?.({
              metric,
              op,
              value,
              channels: (Object.keys(CHANNELS) as ChannelKey[]).filter((k) => channels[k]),
            })
          }
        >
          Arm rule
        </button>
      </div>
    </section>
  );
}
