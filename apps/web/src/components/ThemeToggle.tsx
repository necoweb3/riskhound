"use client";

import { useEffect, useState } from "react";

type Mode = "light" | "dark" | "system";
const KEY = "riskhound-theme";

function systemIsDark() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function apply(mode: Mode) {
  const root = document.documentElement;
  if (mode === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", mode);
  const dark = mode === "dark" || (mode === "system" && systemIsDark());
  // The layout ships media-scoped theme-color tags, so writing to the first
  // match puts the chosen colour on the light-only tag. Only the tag whose
  // media currently matches is the one the browser actually reads.
  const active = Array.from(document.querySelectorAll('meta[name="theme-color"]')).find((m) => {
    const media = m.getAttribute("media");
    return !media || window.matchMedia(media).matches;
  });
  if (active) active.setAttribute("content", dark ? "#08090a" : "#fbfbfc");
}

/** Read the stored preference. Safe to call in the browser only. */
export function readMode(): Mode {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* ignore */
  }
  return "system";
}

export function ThemeToggle() {
  const [mode, setMode] = useState<Mode>("system");
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const initial = readMode();
    setMode(initial);
    setDark(initial === "dark" || (initial === "system" && systemIsDark()));
    apply(initial);

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const current = readMode();
      if (current === "system") setDark(mq.matches);
      // Re-apply either way: the system flip changes which theme-color tag the
      // browser reads, so the chrome colour has to be written to the new one.
      apply(current);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  function set(next: Mode) {
    setMode(next);
    setDark(next === "dark" || (next === "system" && systemIsDark()));
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* ignore */
    }
    apply(next);
  }

  const label =
    mode === "system"
      ? `Theme: following system (${dark ? "dark" : "light"}). Click to switch, shift-click to reset.`
      : `Theme: ${mode}. Click to switch, shift-click to follow system.`;

  return (
    <button
      type="button"
      className="rk-theme-toggle"
      aria-label={label}
      title={label}
      onClick={(event) => {
        if (event.shiftKey) set("system");
        else set(dark ? "light" : "dark");
      }}
    >
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ transform: dark ? "rotate(180deg)" : "none" }}>
        <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.3" />
        <path d="M8 1.75 A6.25 6.25 0 0 0 8 14.25 Z" fill="currentColor" />
      </svg>
    </button>
  );
}

/**
 * Inline, blocking script that sets data-theme before first paint so the page
 * never flashes the wrong theme. Render it in <head> via next/script or a
 * plain <script dangerouslySetInnerHTML> tag.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var m=localStorage.getItem("${KEY}");if(m==="light"||m==="dark"){document.documentElement.setAttribute("data-theme",m);}}catch(e){}})();`;
