# Railway deployment

RiskHound needs three long-running application services plus managed PostgreSQL and Redis:

1. `riskhound-api`
2. `riskhound-worker`
3. `riskhound-web`
4. Railway PostgreSQL
5. Railway Redis

Connect the same repository root to all three application services. In each service, set the Config File path:

- API: `/deploy/railway/api.json`
- Worker: `/deploy/railway/worker.json`
- Web: `/deploy/railway/web.json`

Do not set a fixed `PORT`. Railway injects it. The API and web processes both honor that value.

## Required variables

Shared by API and worker:

- `DATABASE_URL`: reference the Railway PostgreSQL service
- `REDIS_URL`: reference the Railway Redis service
- `REDIS_OPTIONAL=false`
- Arc and source-indexer variables from `.env.example`

API only:

- `NODE_ENV=production`
- `JWT_SECRET`: a new long random value
- `ADMIN_WALLETS`: at least one reviewer wallet address
- `PAYMENT_NETWORK=base`
- `PAYMENT_CHAIN_ID=8453`
- `PAYMENT_RPC_URL=https://mainnet.base.org`
- `PAYMENT_USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- `PAYMENT_RECIPIENT_ADDRESS`: the production recipient wallet
- `X402_FACILITATOR_URL=https://gateway-api.circle.com`
- `X402_ENABLED=true`
- `API_PUBLIC_URL`: the API public HTTPS URL
- `WEB_PUBLIC_URL`: the canonical web HTTPS URL
- `CORS_ORIGIN`: the same canonical web HTTPS URL

Worker only:

- `NODE_ENV=production`
- `BRIDGE_INDEXER_API_URL`: the API service private URL

Web only:

- `NODE_ENV=production`
- `NEXT_PUBLIC_API_URL`: the API public HTTPS URL. This is a build-time value, so redeploy web after changing it.

## Launch order

1. Add PostgreSQL and Redis.
2. Deploy API and verify `/health`.
3. Deploy worker and verify that the API `/health` response receives fresh worker/source timestamps.
4. Deploy web using the API public URL.
5. Attach the canonical domain to web, then update `WEB_PUBLIC_URL` and `CORS_ORIGIN` on API.
6. Run one explicitly approved, low-value Base USDC x402 payment and verify settlement before announcing paid endpoints.

Never commit Railway secrets or production private keys.
