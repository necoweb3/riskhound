# Self-hosted production

RiskHound ships as four production services: web, API, worker, and a one-shot database initializer. PostgreSQL is the shared durable store and Redis backs queues and coordination.

## Required environment

Create a deployment-only environment file and provide:

```env
POSTGRES_PASSWORD=<strong-random-password>
JWT_SECRET=<at-least-32-random-characters>
ADMIN_WALLETS=<comma-separated-admin-wallets>
PAYMENT_RECIPIENT_ADDRESS=<arc-testnet-usdc-receiver>
API_PUBLIC_URL=https://api.example.com
WEB_PUBLIC_URL=https://example.com
```

Optional overrides include `ARC_RPC_URL`, `PAYMENT_RPC_URL`, `POSTGRES_USER`, `POSTGRES_DB`, and `X402_ENABLED`.

## Start

```bash
docker compose --env-file .env.production -f docker-compose.production.yml up -d --build
```

The `migrate` service initializes an empty PostgreSQL database before the API and worker start. Back up the database before applying later schema changes. Terminate TLS at the hosting platform or reverse proxy and route the public web and API hostnames to ports 3001 and 4000 respectively.

Never place wallet seed phrases or private keys in deployment environment variables. Wallet authentication and x402 payment approval are client-signed.
