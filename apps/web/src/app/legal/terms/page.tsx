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
    </div>
  );
}
