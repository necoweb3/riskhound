import { Suspense } from "react";
import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { Nav } from "@/components/Nav";
import { THEME_INIT_SCRIPT } from "@/components/ThemeToggle";
import { StatusBar } from "@/components/StatusBar";
import { ScrollChrome } from "@/components/ScrollChrome";
import { siteUrl } from "@/lib/site";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: {
    default: "RiskHound | Token risk intelligence built on Arc",
    // Every page title ends up branded without repeating it in each file.
    template: "%s | RiskHound",
  },
  description: "Evidence-backed token, creator, holder, liquidity, and bridge risk intelligence built on Arc.",
  icons: { icon: "/riskhound-logo.png", apple: "/riskhound-logo.png" },
  openGraph: {
    type: "website",
    siteName: "RiskHound",
    url: siteUrl(),
    title: "RiskHound | Token risk intelligence built on Arc",
    description: "Inspect token control, exit risk, liquidity, holders, creator history, and bridge evidence.",
  },
  twitter: {
    card: "summary_large_image",
    creator: "@necoweb3",
    title: "RiskHound | Token risk intelligence built on Arc",
    description: "Inspect token control, exit risk, liquidity, holders, creator history, and bridge evidence.",
  },
  robots: { index: true, follow: true },
};

// Media-query themeColor keeps the mobile browser chrome in sync with the theme.
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbfbfc" },
    { media: "(prefers-color-scheme: dark)", color: "#08090a" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Runs before first paint so the stored theme never flashes. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      {/* Extensions (ad blockers, Bitdefender) inject attributes on <body>
          before hydration; this silences that dev-only warning. */}
      <body suppressHydrationWarning>
        <a className="rk-skip" href="#main-content">
          Skip to content
        </a>
        <div className="rk-shell">
          {/* The status strip probes two explorers and an RPC. Streaming it
              keeps that off the critical path: every page used to wait on it,
              including pages that fetch nothing. The placeholder reserves the
              same height so nothing below shifts when it arrives. */}
          <Suspense fallback={<div className="rk-statusbar rk-statusbar--pending" aria-hidden="true" />}>
            <StatusBar />
          </Suspense>
          <Nav />
          <ScrollChrome />
          <main className="rk-main" id="main-content">
            {children}
          </main>
          <footer className="rk-footer">
            <div className="rk-footer__inner">
              <p className="rk-footer__brand" style={{ margin: 0 }}>
                <img className="rk-footer__logo" src="/riskhound-logo.png" alt="" width={28} height={28} />
                <span style={{ fontSize: 12, lineHeight: 1.5, color: "var(--text-3)" }}>
                  Built on Arc. Arc&trade; is a trademark of Circle. Not financial advice.{" "}
                  <a
                    className="rk-footer__credit"
                    href="https://x.com/necoweb3"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Built by @necoweb3
                  </a>
                </span>
              </p>
              <div className="rk-footer__links">
                <Link href="/methodology">How it works</Link>
                <Link href="/legal/terms">Terms and policies</Link>
                <Link href="/appeals">Appeal</Link>
              </div>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
