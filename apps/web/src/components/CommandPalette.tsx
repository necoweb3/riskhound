"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Item = { label: string; hint: string; href: string; keys?: string };

const ITEMS: Item[] = [
  { label: "Discover", hint: "Token inventory", href: "/feed", keys: "G D" },
  { label: "Check a token", hint: "Paste a contract", href: "/scan", keys: "G C" },
  { label: "Watchlist", hint: "Pinned tokens and alerts", href: "/watchlist", keys: "G W" },
  { label: "Creators", hint: "Wallet intelligence", href: "/wallets", keys: "G R" },
  { label: "Bridge watch", hint: "Arc capital flow", href: "/bridge-watch", keys: "G B" },
  { label: "Risk events", hint: "Indexer output", href: "/events", keys: "G E" },
  { label: "How it works", hint: "Methodology", href: "/methodology" },
  { label: "API and pricing", hint: "Endpoints, x402", href: "/api-docs" },
  { label: "Appeal a finding", hint: "Manual review", href: "/appeals" },
  { label: "Terms of use", hint: "Legal", href: "/legal/terms" },
];

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement | null>(null);

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (ADDRESS.test(q.trim())) {
      return [{ label: "Open token report", hint: q.trim(), href: `/token/${q.trim()}` }];
    }
    if (!needle) return ITEMS;
    return ITEMS.filter(
      (it) => it.label.toLowerCase().includes(needle) || it.hint.toLowerCase().includes(needle),
    );
  }, [q]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        setQ("");
        setI(0);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  function go(item: { href: string }) {
    setOpen(false);
    router.push(item.href);
  }

  if (!open) {
    return (
      <button type="button" className="rk-btn rk-btn--sm" onClick={() => setOpen(true)} title="Command palette">
        Jump to <span className="rk-kbd">&#8984;K</span>
      </button>
    );
  }

  return (
    <>
      <button type="button" className="rk-btn rk-btn--sm" onClick={() => setOpen(false)}>
        Jump to <span className="rk-kbd">&#8984;K</span>
      </button>
      <div className="rk-palette-overlay" onClick={() => setOpen(false)} role="presentation">
        <div
          className="rk-palette"
          role="dialog"
          aria-modal="true"
          aria-label="Jump to"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="rk-palette__field">
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-4)" }}>&gt;</span>
            <input
              ref={input}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setI(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setI((v) => Math.min(results.length - 1, v + 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setI((v) => Math.max(0, v - 1));
                } else if (e.key === "Enter" && results[i]) {
                  e.preventDefault();
                  go(results[i]);
                }
              }}
              placeholder="Search screens, or paste a contract address"
              spellCheck={false}
              autoComplete="off"
            />
            <span className="rk-kbd">ESC</span>
          </div>
          <div className="rk-palette__list">
            {results.map((item, idx) => (
              <button
                type="button"
                key={item.href}
                className={`rk-palette__item${idx === i ? " is-active" : ""}`}
                onMouseEnter={() => setI(idx)}
                onClick={() => go(item)}
              >
                <i />
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 13, fontWeight: 550, letterSpacing: "-0.012em" }}>
                    {item.label}
                  </span>
                  <span style={{ display: "block", marginTop: 1, fontSize: 12, color: "var(--text-3)" }}>
                    {item.hint}
                  </span>
                </span>
                {"keys" in item && item.keys ? (
                  <span className="rk-kbd" style={{ marginRight: 14 }}>
                    {item.keys}
                  </span>
                ) : (
                  <span />
                )}
              </button>
            ))}
            {!results.length && (
              <div style={{ padding: "18px 14px", fontSize: 12.5, color: "var(--text-3)" }}>
                Nothing matches. Paste a full contract address to open its report.
              </div>
            )}
          </div>
          <div className="rk-palette__foot">
            <span>Enter to open</span>
            <span>Esc to close</span>
          </div>
        </div>
      </div>
    </>
  );
}
