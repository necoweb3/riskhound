import { apiGet } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function ApiDocsPage() {
  let pricing: {
    features: { feature: string; name: string; description: string; priceUsdc: string; paymentNetwork: string; paymentChainId: number }[];
    paymentNetwork: Record<string, unknown>;
    notes: string[];
  } | null = null;
  try {
    pricing = await apiGet("/v1/pricing");
  } catch {
    pricing = null;
  }

  return (
    <div className="rk-stack-lg rk-reading-page">
      <header className="rk-reading-hero">
        <span className="rk-eyebrow">FOR DEVELOPERS & AGENTS</span>
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
        <pre className="rk-code">{`GET /tokens
GET /tokens/:address
POST /tokens/:address/analyze

GET /observed-mainnet/tokens
GET /observed-mainnet/tokens/:address

GET /wallets/:address
GET /bridge-watch
GET /status/sources`}</pre>
      </section>

      <section className="rk-card rk-stack">
        <div>
        <h2 className="rk-h2">x402 payment integration</h2>
          <p className="rk-muted">Only advanced agent requests use x402. The payment chain does not determine which chain is analyzed.</p>
        </div>
        {pricing?.features?.length ? (
          <div className="rk-api-list">
            {pricing.features.map((feature) => (
              <div className="rk-api-row" key={feature.feature}>
                <div><strong>{feature.name}</strong><span>{feature.description}</span><code>{feature.feature}</code></div>
                <strong>{feature.priceUsdc} USDC</strong>
              </div>
            ))}
          </div>
        ) : <div className="rk-alert" role="alert">Pricing is temporarily unavailable.</div>}
      </section>

      <section className="rk-card rk-stack">
        <h2 className="rk-h2">Payment network</h2>
        <p className="rk-muted" style={{ margin: 0 }}>
          Production x402 payments settle in real USDC on Base Mainnet. Arc Testnet and Observed Arc 5042
          remain analysis targets; the payment rail is independent from the network being analyzed.
        </p>
        <pre className="rk-code">{JSON.stringify(pricing?.paymentNetwork ?? {}, null, 2)}</pre>
      </section>

      <section className="rk-card rk-stack">
        <h2 className="rk-h2">Agent query</h2>
        <pre className="rk-code">{`POST /v1/agent/query
Content-Type: application/json

{
  "question": "block_trade_risk",
  "token": "0x…"
}`}</pre>
        <p className="rk-faint" style={{ margin: 0 }}>Paid requests return an x402 quote before settlement. A client can enforce its own maximum spend.</p>
      </section>
    </div>
  );
}
