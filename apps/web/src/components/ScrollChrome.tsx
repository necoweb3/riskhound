"use client";

import { useEffect } from "react";

/**
 * Drives the two pieces of window chrome that depend on scroll position:
 * the 2px progress bar and the nav shadow. Elements are queried live on every
 * frame, so markup that mounts later is still picked up. Render once, in the
 * root layout, right after <Nav />.
 */
export function ScrollChrome() {
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = 0;
      const y = window.scrollY || 0;
      const h = document.documentElement.scrollHeight - window.innerHeight;
      const bar = document.querySelector<HTMLElement>(".rk-progress > i");
      if (bar) bar.style.transform = `scaleX(${h > 0 ? Math.min(1, y / h) : 0})`;
      document.querySelector(".rk-nav")?.classList.toggle("is-lifted", y > 6);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(tick);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <span className="rk-progress" aria-hidden="true">
      <i />
    </span>
  );
}
