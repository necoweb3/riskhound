"use client";

import { useState } from "react";
import { getApiUrl } from "@/lib/api";

export default function AppealsPage() {
  const [address, setAddress] = useState("");
  const [explanation, setExplanation] = useState("");
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    const normalized = address.trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(normalized)) {
      setMessage({ tone: "error", text: "Enter a valid 0x token address." });
      return;
    }
    if (explanation.trim().length < 10) {
      setMessage({ tone: "error", text: "Explain the issue in at least 10 characters." });
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${getApiUrl()}/appeals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          entityType: "token",
          chain: "arc_testnet",
          address: normalized,
          explanation: explanation.trim(),
          evidenceUrls: evidenceUrl.trim() ? [evidenceUrl.trim()] : [],
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? "The appeal could not be submitted.");
      setMessage({ tone: "ok", text: `Appeal submitted. Reference: ${data.appeal?.id}` });
      setAddress("");
      setExplanation("");
      setEvidenceUrl("");
    } catch (cause) {
      setMessage({ tone: "error", text: cause instanceof Error ? cause.message : "The appeal could not be submitted." });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rk-appeal-layout">
      <header className="rk-reading-hero">
        <span className="rk-eyebrow">MANUAL REVIEW</span>
        <h1 className="rk-h1" style={{ fontSize: "clamp(2rem, 5vw, 2.75rem)" }}>Appeal a finding</h1>
        <p className="rk-lead">
          Send evidence when a token warning appears inaccurate. Automated findings stay in the audit
          trail; a review decision is stored separately.
        </p>
      </header>

      <div className="rk-grid-2 rk-appeal-grid">
        <form className="rk-card rk-stack" onSubmit={submit} noValidate>
          <div>
            <label className="rk-field-label" htmlFor="appeal-address">Token address</label>
            <input id="appeal-address" name="address" className="rk-input rk-input--mono" placeholder="0x…" value={address} onChange={(event) => setAddress(event.target.value)} autoComplete="off" spellCheck={false} disabled={loading} />
          </div>
          <div>
            <label className="rk-field-label" htmlFor="appeal-explanation">What should be reviewed?</label>
            <textarea id="appeal-explanation" name="explanation" className="rk-input rk-textarea" rows={7} placeholder="Explain the finding and why the evidence may be incomplete…" value={explanation} onChange={(event) => setExplanation(event.target.value)} disabled={loading} />
          </div>
          <div>
            <label className="rk-field-label" htmlFor="appeal-evidence">Evidence URL <span className="rk-faint">Optional</span></label>
            <input id="appeal-evidence" name="evidence-url" type="url" className="rk-input" placeholder="https://…" value={evidenceUrl} onChange={(event) => setEvidenceUrl(event.target.value)} autoComplete="off" spellCheck={false} disabled={loading} />
          </div>
          <button className="rk-btn rk-btn--primary rk-btn--lg rk-btn--block" type="submit" disabled={loading}>
            {loading ? "Submitting…" : "Submit appeal"}
          </button>
          {message && <div className={message.tone === "error" ? "rk-alert" : "rk-notice"} role="status" aria-live="polite">{message.text}</div>}
        </form>

        <aside className="rk-card rk-stack rk-appeal-note">
          <h2 className="rk-h2">What happens next</h2>
          <ol className="rk-step-list">
            <li><span>1</span><div><strong>Evidence is recorded</strong><p>Your explanation and reference stay attached to the token.</p></div></li>
            <li><span>2</span><div><strong>The finding is reviewed</strong><p>Onchain proof is compared with the stored signal.</p></div></li>
            <li><span>3</span><div><strong>The audit trail remains</strong><p>Corrections do not silently erase earlier automated results.</p></div></li>
          </ol>
          <p className="rk-faint" style={{ margin: 0 }}>Never include seed phrases, private keys, or personal documents.</p>
        </aside>
      </div>
    </div>
  );
}
