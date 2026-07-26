import Link from "next/link";

export default function TermsPage() {
  return (
    <div>
      <h1>Terms of use</h1>
      <div className="card stack">
        <p>
          RiskHound provides informational security analysis only. Nothing on this platform is
          investment, legal, or financial advice.
        </p>
        <p>
          RiskHound does not execute trades, custody assets, or guarantee the safety of any token or
          wallet.
        </p>
        <p>
          You are solely responsible for decisions made using this information. Onchain data may be
          incomplete, delayed, or incorrect.
        </p>
        <p>
          Paid API access is settled via the configured payment network and is independent of
          analysis networks.
        </p>
      </div>

      {/* The footer links here as "Terms and policies", so the other policies
          have to be reachable from this page. */}
      <div className="card stack mt-2">
        <h2 style={{ margin: 0, fontSize: 16 }}>Other policies</h2>
        <p className="rk-footer__links" style={{ margin: 0 }}>
          <Link href="/legal/privacy">Privacy policy</Link>
          <Link href="/legal/disclaimer">Risk disclaimer</Link>
          <Link href="/api-docs">API and pricing</Link>
          <Link href="/methodology">Methodology</Link>
        </p>
      </div>
    </div>
  );
}
