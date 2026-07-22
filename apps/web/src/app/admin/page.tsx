"use client";

import { useEffect, useState } from "react";
import { getApiUrl } from "@/lib/api";
import { authHeaders, WalletBar, useWallet } from "@/components/WalletBar";

export default function AdminPage() {
  const { wallet } = useWallet();
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [events, setEvents] = useState<{ id: string; title: string; manualStatus: string }[]>([]);
  const [appeals, setAppeals] = useState<{ id: string; address: string; status: string; explanation: string }[]>([]);
  const [error, setError] = useState("");

  async function load() {
    setError("");
    try {
      const h = await fetch(`${getApiUrl()}/admin/health`, {
        headers: authHeaders(),
      }).then((r) => r.json());
      setHealth(h);
      const ev = await fetch(`${getApiUrl()}/admin/events/review`, {
        headers: authHeaders(),
      }).then((r) => r.json());
      setEvents(ev.items ?? []);
      const ap = await fetch(`${getApiUrl()}/admin/appeals`, {
        headers: authHeaders(),
      }).then((r) => r.json());
      setAppeals(ap.items ?? []);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    void load();
  }, [wallet]);

  async function reviewEvent(id: string, manualStatus: "confirmed" | "rejected") {
    await fetch(`${getApiUrl()}/admin/events/${id}/review`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify({ manualStatus, reason: `UI review: ${manualStatus}` }),
    });
    void load();
  }

  return (
    <div>
      <h1>Admin</h1>
      <p className="muted">
        Set ADMIN_WALLETS in env for production. In development, admin routes may be open if no
        admins are configured.
      </p>
      <WalletBar />
      <button className="btn" type="button" onClick={load}>
        Refresh
      </button>
      {error && <p className="source-bad">{error}</p>}

      <section className="card" style={{ marginTop: 12 }}>
        <h2>System health</h2>
        <pre className="mono" style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>
          {JSON.stringify(health, null, 2)}
        </pre>
      </section>

      <section className="card">
        <h2>Event review queue</h2>
        {events.map((e) => (
          <div key={e.id} className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
            <div>
              <strong>{e.title}</strong>
              <div className="dim">{e.manualStatus}</div>
            </div>
            <div className="row">
              <button className="btn" type="button" onClick={() => reviewEvent(e.id, "confirmed")}>
                Confirm
              </button>
              <button className="btn btn-danger" type="button" onClick={() => reviewEvent(e.id, "rejected")}>
                Reject
              </button>
            </div>
          </div>
        ))}
        {!events.length && <p className="muted">Queue empty.</p>}
      </section>

      <section className="card">
        <h2>Appeals</h2>
        {appeals.map((a) => (
          <div key={a.id} className="finding">
            <strong className="mono">{a.address}</strong> · {a.status}
            <p>{a.explanation}</p>
          </div>
        ))}
        {!appeals.length && <p className="muted">No open appeals.</p>}
      </section>
    </div>
  );
}
