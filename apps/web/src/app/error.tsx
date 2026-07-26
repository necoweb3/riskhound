"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * A failed render must not read as a clean result. This says the check did not
 * complete, which is a different statement from "nothing was found".
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[riskhound] render failed", error);
  }, [error]);

  return (
    <div className="rk-notfound">
      <span className="rk-eyebrow">SOMETHING BROKE</span>
      <h1>This check did not complete</h1>
      <p className="rk-lead">
        The page failed to render, so nothing here should be read as a result. It does not mean the
        token is clean, and it does not mean it is risky. Try again, and if it keeps failing the
        analysis service is probably unreachable.
      </p>

      <div className="rk-row" style={{ justifyContent: "center", marginTop: 20 }}>
        <button type="button" className="rk-btn rk-btn--primary" onClick={reset}>
          Try again
        </button>
        <Link href="/" className="rk-btn">
          Go home
        </Link>
      </div>

      {error.digest && (
        <p className="rk-faint rk-mono" style={{ marginTop: 18, fontSize: 11 }}>
          REFERENCE {error.digest}
        </p>
      )}
    </div>
  );
}
