export default function DisclaimerPage() {
  return (
    <div>
      <h1>Disclaimer</h1>
      <div className="card">
        <p>
          RiskHound does not guarantee token safety. Absence of detected risk is not safety. This is
          not investment advice. RiskHound never executes trades or holds user funds.
        </p>
        <p className="dim">
          Risk labels such as “critical” describe automated evidence scoring, not legal findings of
          fraud. Manual review status is shown separately when available.
        </p>
      </div>
    </div>
  );
}
