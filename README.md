# RiskHound

Evidence-based token security and cross-chain wallet intelligence built on **Arc Network**.

RiskHound uses real chain data and never generates mock risk scores. Outside-chain data is supporting creator-history evidence only and is shown when an address relationship is established.

## Stack

| Piece | Tech |
|---|---|
| Web | Next.js 15 (`apps/web`) |
| API | Fastify (`apps/api`) |
| Worker | Indexers + analysis queue (`apps/worker`) |
| DB | SQLite local / Postgres optional (`packages/db`) |
| Cache/queue | Redis optional (BullMQ) |
| Chains | Arc Testnet + Robinhood Chain via Blockscout + viem |

## Quick start (no Docker)

```powershell
cd C:\Users\pc\Desktop\kimirugkill
pnpm install
pnpm setup
```

Then either:

```powershell
.\scripts\dev.ps1
```

or three terminals:

```powershell
pnpm dev:api
pnpm dev:worker
pnpm dev:web
```

- Web: http://localhost:3001
- API: http://localhost:4000

Health check:

```powershell
pnpm health
```

## Optional Docker (Postgres + Redis)

```powershell
.\scripts\infra-up.ps1
# or: pnpm infra:up
```

Local mode works **without** Docker:

- SQLite file: `packages/db/prisma/dev.db`
- `REDIS_OPTIONAL=true` → API/worker run without Redis (inline analysis)

## Environment

Copy `.env.example` → `.env` (`pnpm setup` does this).

Important vars:

| Var | Purpose |
|---|---|
| `DATABASE_URL` | SQLite `file:...` or Postgres URL |
| `REDIS_OPTIONAL` | `true` = start without Redis |
| `ARC_*` | Arc Testnet RPC + explorer |
| `ROBINHOOD_*` | Robinhood explorer |
| `PAYMENT_*` / `X402_*` | Circle Gateway x402 settlement on Base Mainnet |
| `PAYMENT_RECIPIENT_ADDRESS` | Your USDC receive wallet for x402 |
| `ADMIN_WALLETS` | Comma-separated admin addresses |
| `NEXT_PUBLIC_API_URL` | Browser → API URL |

## Architecture

```
apps/web        UI
apps/api        REST + x402 + admin
apps/worker     Arc discovery, Robinhood indexer, analysis, alerts
packages/shared Types, risk model, networks, pricing
packages/chain  Blockscout + RPC clients
packages/analysis Contract / sim / holders / cross-chain / scoring
packages/db     Prisma schema + client
```

## Product principles (enforced in code)

- Every risk signal should be showable onchain
- Missing data is not treated as safety
- No auto “scammer” labels without evidence
- Payment network ≠ analysis network
- No trade execution, no custody, no investment advice

## Scripts

| Command | What |
|---|---|
| `pnpm setup` | .env + prisma generate + db push |
| `pnpm dev` | api + worker + web (parallel) |
| `pnpm health` | Probe API/web |
| `pnpm infra:up` | Docker Postgres/Redis |
| `pnpm test` | Unit tests (shared/chain/analysis) |
| `pnpm db:studio` | Prisma Studio |

## Production handoff

- A production PostgreSQL database and Redis service
- A strong production `JWT_SECRET`
- The owner wallet address in `ADMIN_WALLETS`
- Hosting credentials for the selected web/API/worker providers
- A user-signed low-value Base USDC payment for the final x402 settlement verification

Public Arcscan and Robinhood Blockscout endpoints do not currently require API keys. A dedicated RPC can be added later for higher sustained request limits.

## License

Private / all rights reserved unless stated otherwise.
