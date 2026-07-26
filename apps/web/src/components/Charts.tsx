/**
 * Chart primitives. All of them are plain SVG or flex boxes styled from
 * globals.css, so they render on the server and animate via the scroll-driven
 * .rk-reveal classes. No chart library, no client JS.
 */

const MONO = "var(--font-mono)";

function pathFrom(values: number[], w: number, h: number, pad = 3) {
  if (values.length < 2) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const stepX = w / (values.length - 1);
  return values
    .map((v, i) => {
      const x = +(i * stepX).toFixed(2);
      const y = +(h - pad - ((v - min) / span) * (h - pad * 2)).toFixed(2);
      return `${i === 0 ? "M" : "L"}${x} ${y}`;
    })
    .join(" ");
}

/** Line (optionally filled) sparkline. `len` only needs to be >= path length. */
export function Sparkline({
  values,
  color = "var(--blue)",
  area = false,
  width = 240,
  height = 56,
  len = 700,
}: {
  values: number[];
  color?: string;
  area?: boolean;
  width?: number;
  height?: number;
  len?: number;
}) {
  const d = pathFrom(values, width, height);
  return (
    <svg
      className="rk-spark"
      viewBox={`0 0 ${width} ${height}`}
      height={height}
      fill="none"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {area && (
        <path
          className="rk-reveal rk-reveal--fade"
          d={`${d} L${width} ${height} L0 ${height} Z`}
          fill={`color-mix(in srgb, ${color} 12%, transparent)`}
        />
      )}
      <path
        className="rk-reveal rk-reveal--draw"
        d={d}
        stroke={color}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        style={{ ["--len" as string]: String(len), ["--off" as string]: "0" }}
      />
    </svg>
  );
}

/** Simple column series. Pass `stacked` pairs for two-part columns. */
export function BarSeries({
  values,
  height = 66,
  color,
  highlightFrom,
}: {
  values: number[];
  height?: number;
  color?: string;
  highlightFrom?: number;
}) {
  const max = Math.max(...values, 1);
  return (
    <div className="rk-bars" style={{ height }}>
      {values.map((v, i) => (
        <i
          key={i}
          className="rk-reveal rk-reveal--growY"
          style={{
            height: `${Math.max(8, Math.round((v / max) * 100))}%`,
            background:
              highlightFrom != null && i >= highlightFrom
                ? color ?? "var(--blue)"
                : undefined,
          }}
        />
      ))}
    </div>
  );
}

/** 270 degree score gauge. `score` is 0-100. */
export function ScoreDial({
  score,
  color = "var(--red)",
  size = 118,
  label = "of 100",
}: {
  score: number;
  color?: string;
  size?: number;
  label?: string;
}) {
  const arc = 254.5;
  const off = +(arc * (1 - Math.min(100, Math.max(0, score)) / 100)).toFixed(1);
  const d = "M27.8 104.2 A54 54 0 1 1 104.2 104.2";
  return (
    <span className="rk-dial" style={{ width: size, height: size }}>
      <svg viewBox="0 0 132 132" width={size} height={size} fill="none" aria-hidden="true">
        <path d={d} stroke="var(--surface-3)" strokeWidth="8" strokeLinecap="round" />
        <path
          className="rk-reveal rk-reveal--draw"
          d={d}
          stroke={color}
          strokeWidth="8"
          strokeLinecap="round"
          style={{ ["--len" as string]: String(arc), ["--off" as string]: String(off) }}
        />
      </svg>
      <span className="rk-dial__value">
        <b style={{ fontFamily: MONO, fontSize: size * 0.28, fontWeight: 500, letterSpacing: "-0.04em", lineHeight: 1, color }}>
          {score}
        </b>
        <span style={{ fontFamily: MONO, fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-3)" }}>
          {label}
        </span>
      </span>
    </span>
  );
}

export type Slot = "ok" | "slow" | "down";

/** Availability strip, one cell per sample. */
export function UptimeStrip({ slots }: { slots: Slot[] }) {
  return (
    <div className="rk-uptime">
      {slots.map((s, i) => (
        <i
          key={i}
          className="rk-reveal rk-reveal--growY"
          title={s === "down" ? "Source unavailable" : s === "slow" ? "Degraded latency" : "All sources responding"}
          style={{ background: s === "down" ? "var(--red)" : s === "slow" ? "var(--yellow)" : undefined }}
        />
      ))}
    </div>
  );
}

/** Deployment cadence heatmap. `values` are intensities 0-4. */
export function Heatmap({ values, color = "var(--red)" }: { values: number[]; color?: string }) {
  return (
    <div className="rk-heat">
      {values.map((v, i) => (
        <i
          key={i}
          className="rk-reveal rk-reveal--fade"
          title={v === 0 ? "No deployments" : `${v} deployment${v > 1 ? "s" : ""}`}
          style={v === 0 ? undefined : { background: `color-mix(in srgb, ${color} ${18 + v * 20}%, var(--surface-2))` }}
        />
      ))}
    </div>
  );
}

/** Donut ring for a class mix. Shares must sum to <= 100. */
export function DonutRing({
  slices,
  size = 112,
}: {
  slices: { label: string; share: number; color: string }[];
  size?: number;
}) {
  const c = 251.3;
  let acc = 0;
  return (
    <svg
      className="rk-reveal rk-reveal--fade"
      viewBox="0 0 100 100"
      width={size}
      height={size}
      fill="none"
      aria-hidden="true"
      style={{ flexShrink: 0, transform: "rotate(-90deg)" }}
    >
      <circle cx="50" cy="50" r="40" stroke="var(--surface-3)" strokeWidth="13" />
      {slices.map((s) => {
        const dash = +((s.share / 100) * c).toFixed(1);
        const offset = -acc;
        acc += dash;
        return (
          <circle
            key={s.label}
            cx="50"
            cy="50"
            r="40"
            stroke={s.color}
            strokeWidth="13"
            strokeDasharray={`${dash} ${c}`}
            strokeDashoffset={offset}
          />
        );
      })}
    </svg>
  );
}
