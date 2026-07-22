"use client";

import { useState } from "react";
import { shortAddr } from "@/lib/api";

export function CopyAddress({ address }: { address: string }) {
  const [ok, setOk] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setOk(true);
      setTimeout(() => setOk(false), 1400);
    } catch {
      /* ignore */
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="rk-faint"
      style={{
        background: "var(--surface-2)",
        border: "1px solid var(--line)",
        borderRadius: 12,
        padding: "0.4rem 0.75rem",
        cursor: "pointer",
        fontSize: "0.8rem",
        fontFamily: "ui-monospace, SF Mono, Menlo, monospace",
        letterSpacing: "-0.03em",
        transition: "border-color 0.15s, background 0.15s",
      }}
      title="Copy full address"
    >
      {shortAddr(address)}
      <span
        aria-live="polite"
        style={{
          marginLeft: 12,
          opacity: 0.75,
          fontFamily: "var(--font)",
          fontWeight: 560,
          letterSpacing: "-0.02em",
        }}
      >
        {ok ? "Copied" : "Copy"}
      </span>
    </button>
  );
}
