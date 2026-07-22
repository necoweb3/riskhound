"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { getApiUrl } from "@/lib/api";

export default function ScanPage() {
  const [address, setAddress] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function run(event?: React.FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const addr = address.trim();
      if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) {
        throw new Error("Enter a valid address starting with 0x");
      }
      const res = await fetch(`${getApiUrl()}/tokens/${addr}/analyze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? "Check failed. Try again.");
      router.push(`/token/${addr.toLowerCase()}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rk-stack-lg rk-centered-tool" style={{ maxWidth: 460, margin: "0 auto" }}>
      <header style={{ textAlign: "center" }}>
        <h1 className="rk-h1" style={{ fontSize: "clamp(2rem, 5vw, 2.75rem)" }}>
          Check a token
        </h1>
        <p className="rk-lead" style={{ margin: "0 auto" }}>
          Paste the contract. Get sell, control, and creator signals in plain language.
        </p>
      </header>

      <form className="rk-card rk-stack" style={{ padding: "1.5rem" }} onSubmit={run} noValidate>
        <label
          className="rk-faint"
          htmlFor="addr"
          style={{ fontSize: "0.75rem", fontWeight: 650, letterSpacing: "0.04em", textTransform: "uppercase" }}
        >
          Token address
        </label>
        <input
          id="addr"
          name="token-address"
          className="rk-input rk-input--mono"
          placeholder="0x…"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          disabled={loading}
        />
        <button
          className="rk-btn rk-btn--primary rk-btn--lg rk-btn--block"
          type="submit"
          disabled={loading}
        >
          {loading ? "Checking…" : "Run check"}
        </button>
        {error && <div className="rk-alert" role="alert" aria-live="polite">{error}</div>}
      </form>

      <p className="rk-faint" style={{ textAlign: "center", fontSize: "0.85rem", margin: 0 }}>
        We never ask for keys or seed phrases.
      </p>
    </div>
  );
}
