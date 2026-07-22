"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { getApiUrl } from "@/lib/api";

export function HomeSearch() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go(e?: React.FormEvent) {
    e?.preventDefault();
    const v = q.trim();
    if (!v) return;
    if (/^0x[a-fA-F0-9]{40}$/.test(v)) {
      setError(null);
      setLoading(true);
      try {
        const response = await fetch(`${getApiUrl()}/tokens/${v}/analyze`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(body.message ?? "This address is not a token contract on Arc Testnet.");
        }
        router.push(`/token/${v.toLowerCase()}`);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "The address could not be checked.");
      } finally {
        setLoading(false);
      }
      return;
    }
    router.push(`/feed?q=${encodeURIComponent(v)}`);
  }

  return (
    <form onSubmit={go} className="rk-search" role="search">
      <label className="sr-only" htmlFor="home-search">
        Token address
      </label>
      <input
        id="home-search"
        className="rk-input rk-input--mono"
        placeholder="Paste token address 0x…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        name="token-address"
        inputMode="text"
        autoComplete="off"
        spellCheck={false}
        disabled={loading}
      />
      <button className="rk-btn rk-btn--primary" type="submit" disabled={loading}>
        {loading ? "Checking…" : "Check"}
      </button>
      {error && <div className="rk-search__error" role="alert" aria-live="polite">{error}</div>}
    </form>
  );
}
