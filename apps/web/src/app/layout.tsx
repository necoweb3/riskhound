import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { Nav } from "@/components/Nav";
import { THEME_INIT_SCRIPT } from "@/components/ThemeToggle";
import { StatusBar } from "@/components/StatusBar";
import { ScrollChrome } from "@/components/ScrollChrome";
import "./globals.css";

export const metadata: Metadata = {
  title: "RiskHound | Token risk intelligence built on Arc",
  description: "Evidence-backed token, creator, holder, liquidity, and bridge risk intelligence built on Arc.",
  icons: { icon: "/riskhound-logo.png", apple: "/riskhound-logo.png" },
  openGraph: {
    title: "RiskHound | Token risk intelligence built on Arc",
    description: "Inspect token control, exit risk, liquidity, holders, creator history, and bridge evidence.",
  },
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
      <body>
        <a className="rk-skip" href="#main-content">
          Skip to content
        </a>
        <div className="rk-shell">
          <StatusBar />
          <Nav />
          <ScrollChrome />
          <main className="rk-main" id="main-content">
            {children}
          </main>
          <footer className="rk-footer">
            <div className="rk-footer__inner">
              <p>
                Built on Arc. Arc&trade; is a trademark of Circle. Not financial advice.{" "}
                <a
                  className="rk-footer__credit"
                  href="https://x.com/necoweb3"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Built by @necoweb3
                </a>
              </p>
              <div className="rk-footer__links">
                <Link href="/methodology">How it works</Link>
                <Link href="/api-docs">API</Link>
                <Link href="/legal/terms">Terms</Link>
                <Link href="/legal/privacy">Privacy</Link>
                <Link href="/legal/disclaimer">Disclaimer</Link>
                <Link href="/appeals">Appeal</Link>
              </div>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
