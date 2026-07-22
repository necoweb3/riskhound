"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useState } from "react";

const links = [
  { href: "/feed", label: "Discover" },
  { href: "/scan", label: "Check" },
  { href: "/wallets", label: "Creators" },
  { href: "/bridge-watch", label: "Bridge watch" },
];

export function Nav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <header className={`rk-nav${open ? " is-open" : ""}`}>
      <div className="rk-nav__inner">
        <Link href="/" className="rk-logo" onClick={() => setOpen(false)}>
          <span className="rk-logo__mark">
            <Image src="/riskhound-logo.png" alt="" width={68} height={68} priority />
          </span>
          RiskHound
        </Link>

        <nav className="rk-nav__links" aria-label="Main navigation">
          {links.map((link) => {
            const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
            return (
              <Link
                key={link.href}
                href={link.href}
                className={active ? "is-active" : undefined}
                onClick={() => setOpen(false)}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>

        <div className="rk-nav__right">
          <button
            type="button"
            className="rk-nav__burger"
            aria-expanded={open}
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? "Close" : "Menu"}
          </button>
        </div>
      </div>
    </header>
  );
}
