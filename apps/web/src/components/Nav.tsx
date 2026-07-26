"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { ThemeToggle } from "./ThemeToggle";
import { CommandPalette } from "./CommandPalette";

const links = [
  { href: "/feed", label: "Discover", also: ["/mainnet", "/token"] },
  { href: "/scan", label: "Check", also: [] as string[] },
  { href: "/wallets", label: "Creators", also: ["/wallet"] },
  { href: "/bridge-watch", label: "Bridge", also: [] as string[] },
];

export function Nav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <header className={`rk-nav${open ? " is-open" : ""}`}>
      <div className="rk-nav__inner">
        <Link href="/" className="rk-logo" onClick={() => setOpen(false)}>
          <span className="rk-logo__mark">
            <Image src="/riskhound-logo.png" alt="" width={38} height={38} priority />
          </span>
          <span>RiskHound</span>
        </Link>

        <nav className="rk-nav__links" aria-label="Main navigation">
          {links.map((link) => {
            const active =
              pathname === link.href ||
              pathname.startsWith(`${link.href}/`) ||
              link.also.some((p) => pathname === p || pathname.startsWith(`${p}/`));
            return (
              <Link
                key={link.href}
                href={link.href}
                className={active ? "is-active" : undefined}
                aria-current={active ? "page" : undefined}
                onClick={() => setOpen(false)}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>

        <div className="rk-nav__right">
          <CommandPalette />
          <span className="rk-nav__divider" aria-hidden="true" />
          <ThemeToggle />
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
