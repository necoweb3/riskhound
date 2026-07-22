# Production handoff

RiskHound runs as three processes: Next.js web, Fastify API, and a long-running indexer worker. Production also requires PostgreSQL and Redis. SQLite and inline jobs remain supported for local development only.

## Already configured

- Arc Testnet chain ID `5042002`
- Arcscan Blockscout v2 public API (no API key required)
- Robinhood Blockscout v2 public API (no API key required)
- Arc dRPC read endpoint with official provider fallbacks
- Circle Gateway Testnet facilitator
- Arc ERC-20 USDC `0x3600000000000000000000000000000000000000` (6 decimals)
- x402 receiver `0xC1fd4cd1858c6BD7eFa96f239E04cC46dA84A69C`

## Owner input required once

1. The EVM wallet address that will sign into the private admin area (`ADMIN_WALLETS`). This can be the x402 receiver if the same wallet is controlled by the owner.
2. Deployment account choice/credentials for a web host plus a long-running API/worker host.
3. Production PostgreSQL and Redis connection strings, normally created by the selected host.
4. One Arc Testnet wallet with at least `0.01` USDC to sign the final x402 test payment. Never provide its private key or seed phrase.
5. Optional custom domain when ready; it does not block functional deployment.

Production secrets must be entered in the host secret store. Do not commit `.env`.
