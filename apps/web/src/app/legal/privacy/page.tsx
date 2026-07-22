export default function PrivacyPage() {
  return (
    <div>
      <h1>Privacy policy</h1>
      <div className="card stack">
        <p>
          RiskHound does not require users to connect a wallet for public analysis. Agent API payment
          records may include the payer address supplied by the x402 protocol.
        </p>
        <p>
          Onchain data is public by nature. Analysis results may be cached to improve performance.
        </p>
        <p>Logs should not include secrets. Operators must configure secrets via environment variables.</p>
      </div>
    </div>
  );
}
