export const dynamic = "force-dynamic";

const QUESTIONS = [
  ["critical_contract_risk", "Does the contract carry a critical privilege or code risk"],
  ["can_sell", "Did a fresh address complete a sell in simulation"],
  ["deployer_risky_history", "Has the creator deployed before"],
  ["creator_confirmed_external_history", "Is the creator linked to confirmed off-Arc risk events"],
  ["wallet_funded_from_risk_event", "Was this wallet funded from an address tied to a confirmed event"],
  ["holder_linked_pct", "What share of supply sits in linked wallets"],
  ["recent_critical_liquidity", "Were there recent liquidity removals"],
  ["block_trade_risk", "Is there a hard-block signal against trading"],
  ["funding_link_between", "Is there a funding link between two wallets"],
  ["shortest_path_to_risk", "How many hops to a confirmed risk address"],
];

export default function ApiDocsPage() {
  return (
    <div className="rk-stack-lg rk-reading-page">
      <header className="rk-reading-hero">
        <span className="rk-eyebrow">FOR DEVELOPERS &amp; AGENTS</span>
        <h1 className="rk-h1" style={{ fontSize: "clamp(2rem, 5vw, 2.75rem)" }}>RiskHound API</h1>
        <p className="rk-lead">
          The API powers this product and exposes the same evidence to agents and integrations. Arc Testnet
          supports full analysis; Observed Arc 5042 currently supports read-only token and risk evidence.
        </p>
      </header>

      <section className="rk-card rk-stack">
        <h2 className="rk-h2">Network coverage</h2>
        <div className="rk-api-coverage">
          <div><strong>Arc Testnet</strong><span>Token discovery, contract analysis, holder checks, creator intelligence, and simulations.</span></div>
          <div><strong>Observed Arc 5042</strong><span>Token inventory, verification state, holder concentration, creator metadata, and bridge links when available.</span></div>
        </div>
        <pre className="rk-code">{`GET  /tokens
GET  /tokens/:address
POST /tokens/:address/analyze

GET  /observed-mainnet/tokens
GET  /observed-mainnet/tokens/:address

GET  /wallets/:address
GET  /bridge-watch
GET  /stats
GET  /status/sources
GET  /methodology`}</pre>
      </section>

      <section className="rk-card rk-stack">
        <div>
          <h2 className="rk-h2">Access</h2>
          <p className="rk-muted">
            No account, no key and no payment. Endpoints that run a full analysis are rate limited per
            client because each call fans out to dozens of chain and explorer requests. Read endpoints
            share the general limit.
          </p>
        </div>
        <p className="rk-faint" style={{ margin: 0 }}>
          Every response carries the analysis timestamp, the last block read and the health of each data
          source it used, so a caller can tell a fresh answer from a stale or partial one.
        </p>
      </section>

      <section className="rk-card rk-stack">
        <h2 className="rk-h2">Agent query</h2>
        <pre className="rk-code">{`POST /v1/agent/query
Content-Type: application/json

{
  "question": "block_trade_risk",
  "token": "0x…"
}`}</pre>
        <div className="rk-api-list">
          {QUESTIONS.map(([q, desc]) => (
            <div className="rk-api-row" key={q}>
              <div><code>{q}</code><span>{desc}</span></div>
            </div>
          ))}
        </div>
        <p className="rk-faint" style={{ margin: 0 }}>
          An answer of <code>null</code> means the check could not be completed. It never means the token
          passed.
        </p>
      </section>

      <section className="rk-card rk-stack">
        <h2 className="rk-h2">Full analysis</h2>
        <pre className="rk-code">{`POST /v1/report          { "address": "0x…" }
POST /v1/simulation      { "address": "0x…" }
POST /v1/funding-graph   { "address": "0x…" }`}</pre>
      </section>
    </div>
  );
}
