import { apiGet } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function MethodologyPage() {
  let data: {
    principles?: string[];
    disclaimer?: string;
    limitations?: string[];
  } | null = null;
  try {
    data = await apiGet("/methodology");
  } catch {
    data = null;
  }

  return (
    <div className="rk-stack-lg rk-reading-page">
      <header className="rk-reading-hero">
        <h1 className="rk-h1" style={{ fontSize: "2rem" }}>
          How it works
        </h1>
        <p className="rk-lead">
          RiskHound is an early-warning system built on Arc. It turns onchain evidence into
          understandable risk signals without inventing scammer labels or treating missing data as safety.
        </p>
      </header>

      <div className="rk-reading-grid">
      <section className="rk-card rk-reading-card">
        <h2 className="rk-h2">Principles</h2>
        <ul className="rk-muted" style={{ margin: 0, paddingLeft: "1.1rem" }}>
          {(
            data?.principles ?? [
              "Every flag should be showable onchain.",
              "Missing data is not safe.",
              "We do not execute trades or give investment advice.",
            ]
          ).map((p) => (
            <li key={p} style={{ marginBottom: 8 }}>
                    {p}
            </li>
          ))}
        </ul>
      </section>

      <section className="rk-card rk-reading-card">
        <h2 className="rk-h2">What RiskHound checks</h2>
        <ul className="rk-muted" style={{ margin: 0, paddingLeft: "1.1rem" }}>
          <li style={{ marginBottom: 8 }}><strong>Exit risk:</strong> sell-path failures, transfer restrictions, freezes, blacklists, and honeypot-like behavior.</li>
          <li style={{ marginBottom: 8 }}><strong>Contract control:</strong> ownership, administrative powers, proxy upgrades, mint authority, and dangerous callable functions.</li>
          <li style={{ marginBottom: 8 }}><strong>Liquidity:</strong> pool visibility, LP concentration, removable exit liquidity, and suspicious add/remove events.</li>
          <li style={{ marginBottom: 8 }}><strong>Supply ownership:</strong> top-holder concentration, deployer holdings, linked wallets, and insider clusters.</li>
          <li style={{ marginBottom: 8 }}><strong>Creator history:</strong> previous deployments, first funders, connected addresses, and evidence-confirmed harmful activity.</li>
          <li><strong>Bridge intelligence:</strong> Arc-targeted CCTP burns, Circle attestation state, independently observed mint state, and high-value recipient activity.</li>
        </ul>
      </section>

      </div>

      <section className="rk-card rk-reading-card">
        <h2 className="rk-h2">How it helps prevent a rug</h2>
        <p className="rk-muted" style={{ marginTop: 0 }}>
          RiskHound does not block a transaction or guarantee safety. It reduces avoidable risk by exposing
          control, exit, concentration, liquidity, and creator-history signals before a user decides to interact.
        </p>
        <p className="rk-muted" style={{ marginBottom: 0 }}>
          Critical findings cannot be hidden by a low average score. Every finding keeps its evidence,
          confidence, data-source health, and known limitations visible.
        </p>
      </section>

      <section className="rk-card rk-reading-card">
        <h2 className="rk-h2">Risk levels</h2>
        <ul className="rk-muted" style={{ margin: 0, paddingLeft: "1.1rem" }}>
          <li style={{ marginBottom: 8 }}>
            <strong>Critical:</strong> severe issues like blocked sells or dangerous powers
          </li>
          <li style={{ marginBottom: 8 }}>
            <strong>High:</strong> serious concentration or control risks
          </li>
          <li style={{ marginBottom: 8 }}>
            <strong>Caution:</strong> notable issues; dig deeper
          </li>
          <li style={{ marginBottom: 8 }}>
            <strong>Lower risk:</strong> fewer flags found (not a green light)
          </li>
          <li style={{ marginBottom: 8 }}>
            <strong>Limited data:</strong> we could not see enough to judge
          </li>
        </ul>
      </section>

      {data?.limitations?.length ? (
        <section className="rk-card">
          <h2 className="rk-h2">Limits</h2>
          <ul className="rk-muted" style={{ margin: 0, paddingLeft: "1.1rem" }}>
            {data.limitations.map((n) => (
              <li key={n} style={{ marginBottom: 8 }}>
                {n}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="rk-faint rk-methodology-disclaimer" style={{ fontSize: "0.82rem" }}>
        RiskHound is built on Arc Network. Arc is a trademark of Circle Internet Group, Inc. and/or its affiliates.
        RiskHound is an independent product and does not imply endorsement or partnership. {data?.disclaimer ?? "RiskHound does not guarantee token safety. Absence of detected risk is not safety. This is not investment advice. RiskHound never executes trades or holds user funds."}
      </p>
    </div>
  );
}
