import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { Nav } from "@/components/Nav";
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

export const viewport: Viewport = { themeColor: "#f6f6f7" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <a className="rk-skip" href="#main-content">Skip to content</a>
        <div className="rk-shell">
          <Nav />
          <main className="rk-main" id="main-content">{children}</main>
          <footer className="rk-footer">
            <div className="rk-footer__inner">
              <p>
                RiskHound is built on Arc. Arc™ is a trademark of Circle. Not financial advice.{" "}
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
