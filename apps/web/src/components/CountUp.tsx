"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Counts a number up the first time it scrolls into view, then leaves it
 * alone. Renders the final value on the server so the number is correct with
 * JS disabled and for crawlers.
 */
export function CountUp({
  value,
  decimals = 0,
  duration = 850,
  className,
}: {
  value: number;
  decimals?: number;
  duration?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [shown, setShown] = useState(value);
  const done = useRef(false);

  const fmt = (v: number) =>
    decimals > 0 ? v.toFixed(decimals) : Math.round(v).toLocaleString("en-US");

  useEffect(() => {
    const el = ref.current;
    if (!el || done.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const io = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting || done.current) return;
        done.current = true;
        io.disconnect();
        let t0 = 0;
        const step = (t: number) => {
          if (!t0) t0 = t;
          const p = Math.min(1, (t - t0) / duration);
          setShown(value * (1 - Math.pow(1 - p, 3)));
          if (p < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      },
      { threshold: 0.2 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [value, duration]);

  return (
    <span ref={ref} className={className} style={{ fontVariantNumeric: "tabular-nums" }}>
      {fmt(shown)}
    </span>
  );
}
