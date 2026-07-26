"use client";

/**
 * Catches a failure in the root layout itself, where the normal error boundary
 * cannot mount. It has to bring its own html and body, and it cannot rely on
 * the stylesheet having loaded, so the few styles it needs are inline.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          padding: 24,
          background: "#fbfbfc",
          color: "#15161a",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          textAlign: "center",
        }}
      >
        <div style={{ maxWidth: 480 }}>
          <p style={{ margin: "0 0 10px", fontSize: 11, letterSpacing: "0.1em", color: "#6f717a" }}>
            RISKHOUND
          </p>
          <h1 style={{ margin: "0 0 12px", fontSize: 24, fontWeight: 600 }}>The site failed to load</h1>
          <p style={{ margin: "0 0 20px", fontSize: 14, lineHeight: 1.6, color: "#54565e" }}>
            Nothing on this page is a result. Reload to try again.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              height: 36,
              padding: "0 16px",
              borderRadius: 6,
              border: "1px solid #15161a",
              background: "#15161a",
              color: "#fbfbfc",
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            Reload
          </button>
          {error.digest && (
            <p style={{ marginTop: 16, fontSize: 11, color: "#6f717a", fontFamily: "ui-monospace, monospace" }}>
              REFERENCE {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}
