"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function WalletsSearchPage() {
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function openProfile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = address.trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(normalized)) {
      setError("Enter a valid wallet address starting with 0x.");
      return;
    }
    setError(null);
    router.push(`/wallet/${normalized.toLowerCase()}`);
  }

  return (
    <div className="rk-stack-lg rk-centered-tool" style={{ maxWidth: 520, margin: "0 auto" }}>
      <header style={{ textAlign: "center" }}>
        <h1 className="rk-h1" style={{ fontSize: "clamp(1.75rem, 4vw, 2.4rem)" }}>
          Look up a wallet
        </h1>
        <p className="rk-lead" style={{ margin: "0 auto" }}>
          See tokens created, funding links, and related risk events.
        </p>
      </header>
      <form className="rk-card rk-stack" onSubmit={openProfile} noValidate>
        <label className="sr-only" htmlFor="wallet-address">Wallet address</label>
        <input
          id="wallet-address"
          name="wallet-address"
          className="rk-input rk-input--mono"
          placeholder="0x…"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
        <button
          className="rk-btn rk-btn--primary rk-btn--lg rk-btn--block"
          type="submit"
        >
          Open profile
        </button>
        {error && <div className="rk-alert" role="alert" aria-live="polite">{error}</div>}
      </form>
    </div>
  );
}
