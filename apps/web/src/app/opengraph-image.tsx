import { ImageResponse } from "next/og";

export const runtime = "nodejs";
export const alt = "RiskHound, evidence-backed token risk intelligence on Arc";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * Shared links had no preview card at all. Drawn with the site's own palette
 * and the same rule it applies everywhere: state what is measured, claim
 * nothing beyond it.
 */
export default async function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#08090a",
          color: "#f1f2f4",
          padding: 72,
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 10, height: 10, background: "#7d9bf7", borderRadius: 2, display: "flex" }} />
          <div style={{ fontSize: 22, letterSpacing: 6, color: "#868b95", display: "flex" }}>RISKHOUND</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 76, fontWeight: 700, letterSpacing: -2, lineHeight: 1.05, display: "flex" }}>
            Evidence before exposure.
          </div>
          <div style={{ fontSize: 27, color: "#9da2ac", marginTop: 22, lineHeight: 1.45, maxWidth: 940, display: "flex" }}>
            Sell traps, hidden control, concentrated supply and creator history, each signal linked to
            the transaction that proves it.
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", gap: 12 }}>
            {["READ ONLY", "NO WALLET CONNECTION", "BUILT ON ARC"].map((t) => (
              <div
                key={t}
                style={{
                  display: "flex",
                  border: "1px solid #22252b",
                  borderRadius: 6,
                  padding: "9px 15px",
                  fontSize: 17,
                  letterSpacing: 1.4,
                  color: "#868b95",
                }}
              >
                {t}
              </div>
            ))}
          </div>
          <div style={{ fontSize: 20, color: "#787d86", display: "flex" }}>riskhound.xyz</div>
        </div>
      </div>
    ),
    size
  );
}
