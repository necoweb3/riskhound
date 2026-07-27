"use client";

import { useEffect, useState } from "react";
import { getApiUrl } from "@/lib/api";
import { authHeaders, WalletBar, useWallet } from "@/components/WalletBar";

/** A refused request must read as refused, never as an empty review queue. */
function failure(status: number) {
  if (status === 401 || status === 403) {
    return new Error("Not signed in as an admin. Connect an admin wallet and sign in.");
  }
  return new Error(`Admin request failed (${status}).`);
}

async function adminGet<T>(path: string): Promise<T> {
  const res = await fetch(`${getApiUrl()}${path}`, { headers: authHeaders() });
  if (!res.ok) throw failure(res.status);
  return (await res.json()) as T;
}

export default function AdminPage() {
  const { wallet, session } = useWallet();
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [events, setEvents] = useState<{ id: string; title: string; manualStatus: string }[]>([]);
  const [appeals, setAppeals] = useState<{ id: string; address: string; status: string; explanation: string }[]>([]);
  const [error, setError] = useState("");

  async function load() {
    setError("");
    try {
      // None of the three feeds another, so the review queue must not wait
      // behind the health blob's six database queries.
      const [h, ev, ap] = await Promise.all([
        adminGet<Record<string, unknown>>("/admin/health"),
        adminGet<{ items?: { id: string; title: string; manualStatus: string }[] }>("/admin/events/review"),
        adminGet<{ items?: { id: string; address: string; status: string; explanation: string }[] }>("/admin/appeals"),
      ]);
      setHealth(h);
      setEvents(ev.items ?? []);
      setAppeals(ap.items ?? []);
    } catch (e) {
      // Drop whatever was on screen: unreadable is not the same as none.
      setHealth(null);
      setEvents([]);
      setAppeals([]);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void load();
  }, [wallet, session]);

  async function reviewEvent(id: string, manualStatus: "confirmed" | "rejected") {
    const res = await fetch(`${getApiUrl()}/admin/events/${id}/review`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify({ manualStatus, reason: `UI review: ${manualStatus}` }),
    });
    if (!res.ok) {
      setError(failure(res.status).message);
      return;
    }
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
        {!events.length && <p className="muted">{error ? "Queue could not be loaded." : "Queue empty."}</p>}
      </section>

      <section className="card">
        <h2>Appeals</h2>
        {appeals.map((a) => (
          <div key={a.id} className="finding">
            <strong className="mono">{a.address}</strong> · {a.status}
            <p>{a.explanation}</p>
          </div>
        ))}
        {!appeals.length && <p className="muted">{error ? "Appeals could not be loaded." : "No open appeals."}</p>}
      </section>
    </div>
  );
}
