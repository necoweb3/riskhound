import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms and policies | RiskHound",
  description: "Terms of use, privacy policy and risk disclaimer for RiskHound.",
};

/**
 * One page for every policy. They were three near-empty pages before, two of
 * which nothing linked to. Anchors keep the old deep links working.
 */
const SECTIONS = [
  {
    id: "terms",
    n: "01",
    title: "Terms of use",
    lede: "What RiskHound is, and what it is not.",
    points: [
      {
        h: "Informational analysis only",
        p: "RiskHound reports what it can read from the chain. Nothing here is investment, legal, financial or tax advice, and no output is a recommendation to buy, sell or hold anything.",
      },
      {
        h: "No execution, no custody",
        p: "RiskHound never executes a trade, never routes an order and never holds, moves or has access to your funds or keys. Public analysis does not require a wallet connection.",
      },
      {
        h: "Decisions remain yours",
        p: "You are solely responsible for what you do with this information. Onchain data can be incomplete, delayed or wrong, and an analysis describes a moment in time that the chain may have already moved past.",
      },
      {
        h: "Fair use of the API",
        p: "The API is free and needs no account. Endpoints that run a full analysis are rate limited per client, because each call fans out to dozens of chain and explorer requests. Automated clients should honour those limits.",
      },
    ],
  },
  {
    id: "privacy",
    n: "02",
    title: "Privacy",
    lede: "What is stored, and what is deliberately not.",
    points: [
      {
        h: "No wallet needed to read",
        p: "Browsing, searching and reading a report requires no account and no wallet connection. An address is stored only when you sign in to use the watchlist or the reviewer tools, and it is stored as an address, never as a key.",
      },
      {
        h: "Onchain data is already public",
        p: "Everything RiskHound analyses is public by nature: contracts, balances, transfers and transactions. Results are cached so a report does not have to re-read the chain on every visit.",
      },
      {
        h: "Secrets stay out of logs",
        p: "Operators configure credentials through environment variables. Application logs are not a place for secrets and are not intended to carry them.",
      },
    ],
  },
  {
    id: "disclaimer",
    n: "03",
    title: "Risk disclaimer",
    lede: "How to read a result, and how not to.",
    points: [
      {
        h: "Absence of a finding is not safety",
        p: "A clear category means nothing was flagged with the data available. It does not mean the token is safe. Where a source could not be read, the report says so rather than scoring the gap as clean.",
      },
      {
        h: "Severity is not a legal finding",
        p: "Labels such as critical describe automated evidence scoring. They are not accusations of fraud and not findings of law. Where a human has reviewed something, that status is shown separately from the automatic detection.",
      },
      {
        h: "Nothing is guaranteed",
        p: "RiskHound does not guarantee the safety of any token, contract or wallet, and cannot promise that an analysis is complete or current.",
      },
    ],
  },
];

const NEVER = [
  "Execute a trade or route an order",
  "Hold funds, keys or custody of any kind",
  "Score a missing data source as safe",
  "Label an address without reviewable evidence",
];

export default function TermsPage() {
  return (
    <div className="rk-reading-page rk-stack-lg">
      <header className="rk-reading-hero">
        <span className="rk-eyebrow">LEGAL</span>
        <h1 className="rk-h1" style={{ fontSize: "clamp(2rem, 5vw, 2.75rem)" }}>Terms and policies</h1>
        <p className="rk-lead">
          Terms of use, privacy and the risk disclaimer, in one place. Plain language on purpose:
          a policy nobody can read protects nobody.
        </p>
      </header>

      <div className="rk-policy">
        <nav className="rk-policy__nav" aria-label="Policy sections">
          <p className="rk-eyebrow">ON THIS PAGE</p>
          {SECTIONS.map((s) => (
            <a key={s.id} href={`#${s.id}`}>
              <span className="rk-policy__n">{s.n}</span>
              <span>{s.title}</span>
            </a>
          ))}
          <div className="rk-policy__never">
            <p className="rk-eyebrow">RISKHOUND NEVER WILL</p>
            <ul>
              {NEVER.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </nav>

        <div className="rk-policy__body">
          {SECTIONS.map((s) => (
            <section key={s.id} id={s.id} className="rk-policy__section">
              <div className="rk-policy__head">
                <span className="rk-policy__n">{s.n}</span>
                <div>
                  <h2>{s.title}</h2>
                  <p>{s.lede}</p>
                </div>
              </div>
              <dl>
                {s.points.map((point) => (
                  <div key={point.h}>
                    <dt>{point.h}</dt>
                    <dd>{point.p}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}

          <p className="rk-policy__foot">
            Questions about a specific finding belong in an appeal rather than here.{" "}
            <a href="/appeals">Submit evidence for manual review</a>.
          </p>
        </div>
      </div>
    </div>
  );
}
