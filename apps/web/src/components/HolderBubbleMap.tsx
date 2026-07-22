"use client";

import Link from "next/link";
import { shortAddr } from "@/lib/api";

export type BubbleHolder = {
  address: string;
  balance: string;
  pct: number | null;
  labels?: string[];
};

type Placed = BubbleHolder & {
  x: number;
  y: number;
  r: number;
  pctVal: number;
  color: string;
};

const COLORS = [
  "rgba(124, 184, 255, 0.88)",
  "rgba(167, 139, 250, 0.88)",
  "rgba(61, 214, 140, 0.85)",
  "rgba(245, 185, 66, 0.88)",
  "rgba(255, 107, 134, 0.88)",
  "rgba(45, 212, 191, 0.85)",
  "rgba(244, 114, 182, 0.85)",
  "rgba(148, 163, 184, 0.8)",
];

function layoutBubbles(holders: BubbleHolder[], width: number, height: number): Placed[] {
  const withPct = holders
    .map((h, i) => ({
      ...h,
      pctVal: h.pct != null && h.pct > 0 ? h.pct : Math.max(0.4, 6 - i * 0.35),
    }))
    .filter((h) => h.pctVal > 0)
    .slice(0, 18);

  if (!withPct.length) return [];

  const maxPct = Math.max(...withPct.map((h) => h.pctVal), 1);
  const minR = 20;
  const maxR = Math.min(width, height) * 0.22;
  const placed: Placed[] = [];
  const cx = width / 2;
  const cy = height / 2;
  const sorted = [...withPct].sort((a, b) => b.pctVal - a.pctVal);

  for (let i = 0; i < sorted.length; i++) {
    const h = sorted[i];
    const r = minR + Math.sqrt(h.pctVal / maxPct) * (maxR - minR);
    let x = cx;
    let y = cy;
    let color = COLORS[i % COLORS.length];
    if (h.labels?.includes("deployer")) color = "rgba(255, 107, 134, 0.92)";

    if (i === 0) {
      placed.push({ ...h, x, y, r, color });
      continue;
    }

    let angle = i * 2.4;
    let dist = r + placed[0].r * 0.4;
    let attempts = 0;
    let ok = false;
    while (attempts < 90 && !ok) {
      x = cx + Math.cos(angle) * dist;
      y = cy + Math.sin(angle) * dist * 0.9;
      x = Math.max(r + 6, Math.min(width - r - 6, x));
      y = Math.max(r + 6, Math.min(height - r - 6, y));
      ok = placed.every((p) => Math.hypot(p.x - x, p.y - y) >= p.r + r + 4);
      if (!ok) {
        angle += 0.55;
        dist += 5;
        attempts++;
      }
    }
    placed.push({ ...h, x, y, r, color });
  }
  return placed;
}

function formatShare(value: number | null) {
  if (value == null) return "share unavailable";
  if (value >= 0 && value < 0.01) return "<0.01%";
  if (value > 0 && value < 0.1) return "<0.1%";
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

export function HolderBubbleMap({
  holders,
  height = 360,
}: {
  holders: BubbleHolder[];
  height?: number;
}) {
  const width = 680;
  const placed = layoutBubbles(holders ?? [], width, height);

  if (!placed.length) {
    return (
      <div className="rk-empty" style={{ padding: "2rem 1rem" }}>
        <strong>No holder map yet</strong>
        Holder shares are not available for this token right now.
      </div>
    );
  }

  const topShare = [...placed]
    .sort((a, b) => (b.pct ?? b.pctVal) - (a.pct ?? a.pctVal))
    .slice(0, 5)
    .reduce((a, h) => a + (h.pct ?? 0), 0);

  return (
    <div className="rk-bubble">
      <div className="rk-bubble__stats">
        <div>
          <span className="rk-bubble__stat-val">{placed.length}</span>
          <span className="rk-bubble__stat-label">shown</span>
        </div>
        <div>
          <span className="rk-bubble__stat-val">
            {topShare > 0 ? `${topShare.toFixed(0)}%` : "n/a"}
          </span>
          <span className="rk-bubble__stat-label">top 5 share</span>
        </div>
      </div>

      <div className="rk-bubble__canvas-wrap">
        <svg
          className="rk-bubble__canvas"
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="Holder distribution map"
        >
          <defs>
            <radialGradient id="rk-bubble-glow" cx="50%" cy="40%" r="60%">
              <stop offset="0%" stopColor="rgba(124,184,255,0.08)" />
              <stop offset="100%" stopColor="rgba(0,0,0,0)" />
            </radialGradient>
          </defs>
          <rect width={width} height={height} fill="url(#rk-bubble-glow)" rx="16" />

          {placed.map((p) => (
            <a
              key={p.address}
              className="rk-bubble__node"
              href={`/wallet/${p.address}`}
              aria-label={`${shortAddr(p.address)}, ${formatShare(p.pct)}`}
            >
              <circle
                cx={p.x}
                cy={p.y}
                r={p.r}
                fill={p.color}
                stroke="rgba(255,255,255,0.2)"
                strokeWidth={1.5}
              />
              {p.r >= 22 && (
                <text
                  x={p.x}
                  y={p.y - 1}
                  textAnchor="middle"
                  fill="#fff"
                  fontSize={p.r > 42 ? 13 : 11}
                  fontWeight={700}
                  style={{ pointerEvents: "none" }}
                >
                  {p.pct != null ? formatShare(p.pct) : shortAddr(p.address)}
                </text>
              )}
              {p.r >= 38 && (
                <text
                  x={p.x}
                  y={p.y + 13}
                  textAnchor="middle"
                  fill="rgba(255,255,255,0.8)"
                  fontSize={9}
                  style={{ pointerEvents: "none" }}
                >
                  {shortAddr(p.address)}
                </text>
              )}
              <title>
                {shortAddr(p.address)}
                {p.pct != null ? ` · ${p.pct.toFixed(2)}%` : ""}
                {p.labels?.includes("deployer") ? " · Creator" : ""}
              </title>
            </a>
          ))}
        </svg>
      </div>

      <ul className="rk-bubble__legend">
        {placed.slice(0, 8).map((p) => (
          <li key={p.address}>
            <span className="rk-bubble__swatch" style={{ background: p.color }} />
            <Link
              href={`/wallet/${p.address}`}
              className="rk-mono"
              style={{
                background: "none",
                border: "none",
                padding: 0,
                cursor: "pointer",
                color: "inherit",
              }}
            >
              {shortAddr(p.address)}
            </Link>
            <span className="rk-faint">
              {formatShare(p.pct)}
            </span>
            {p.labels?.includes("deployer") && <span className="rk-chip">Creator</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
