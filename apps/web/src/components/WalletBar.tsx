"use client";

import { useEffect, useState } from "react";

const KEY = "rugkiller_wallet";
const SESSION_KEY = "rugkiller_session";

type EthereumProvider = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };

export function authHeaders(): Record<string, string> {
  const token = typeof window === "undefined" ? null : localStorage.getItem(SESSION_KEY);
  return token ? { authorization: `Bearer ${token}` } : {};
}

// Session identity is shared, not per component: a page that authenticates
// with it has to hear about a sign-in that happened in the wallet bar.
const listeners = new Set<() => void>();

function read(key: string) {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

export function useWallet() {
  const [state, setState] = useState({ wallet: "", session: "" });

  useEffect(() => {
    const sync = () => setState({ wallet: read(KEY), session: read(SESSION_KEY) });
    sync();
    listeners.add(sync);
    return () => {
      listeners.delete(sync);
    };
  }, []);

  const save = (v: string) => {
    const n = v.trim().toLowerCase();
    if (n) localStorage.setItem(KEY, n);
    else localStorage.removeItem(KEY);
    listeners.forEach((fn) => fn());
  };

  return { wallet: state.wallet, session: state.session, setWallet: save };
}

export function WalletBar() {
  const { wallet, setWallet } = useWallet();
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    setDraft(wallet);
  }, [wallet]);

  async function authenticate() {
    setStatus("");
    const provider = (window as unknown as { ethereum?: EthereumProvider }).ethereum;
    if (!provider) {
      setStatus("A browser wallet is required to sign in.");
      return;
    }
    try {
      const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
      const address = accounts[0]?.toLowerCase();
      if (!address) throw new Error("No wallet account returned.");
      const challenge = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000"}/auth/challenge?address=${address}`).then((r) => r.json());
      const signature = await provider.request({ method: "personal_sign", params: [challenge.message, address] });
      const verified = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000"}/auth/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challenge: challenge.challenge, message: challenge.message, signature }),
      }).then((r) => r.json());
      if (!verified.sessionToken) throw new Error("Signature verification failed.");
      localStorage.setItem(SESSION_KEY, verified.sessionToken);
      setWallet(address);
      setDraft(address);
      setStatus("Signed in");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Sign-in failed");
    }
  }

  return (
    <div className="card row" style={{ marginBottom: "1rem" }}>
      <div style={{ flex: 1, minWidth: 200 }}>
        <div className="dim" style={{ fontSize: "0.8rem", marginBottom: 4 }}>
          Session wallet (address only, for the watchlist and reviewer tools, never a key)
        </div>
        <input
          className="input mono"
          placeholder="0x… wallet address"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      </div>
      <button className="btn btn-primary" type="button" onClick={authenticate}>
        Sign in
      </button>
      {wallet && (
        <button className="btn" type="button" onClick={() => { localStorage.removeItem(SESSION_KEY); setWallet(""); }}>
          Clear
        </button>
      )}
      {status && <span className="dim">{status}</span>}
    </div>
  );
}
