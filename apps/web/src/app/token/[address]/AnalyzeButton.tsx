"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { getApiUrl } from "@/lib/api";

export function AnalyzeButton({ address }: { address: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  async function run() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`${getApiUrl()}/tokens/${address}/analyze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force: true }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { message?: string } | null;
        throw new Error(body?.message ?? "The analysis service could not refresh this token.");
      }
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error && cause.message !== "Failed to fetch"
        ? cause.message
        : "Could not reach the analysis service. Check that the local API is running, then try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rk-action-status">
      <button className="rk-btn rk-btn--sm rk-btn--primary" type="button" onClick={run} disabled={loading}>
        {loading ? "Refreshing…" : "Refresh Analysis"}
      </button>
      {error ? <span className="rk-action-error" role="status">{error}</span> : null}
    </div>
  );
}
