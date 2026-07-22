# Infrastructure

## Local default (recommended)

No Docker required.

| Service | How |
|---|---|
| Database | SQLite `packages/db/prisma/dev.db` |
| Queue | Disabled when Redis offline (`REDIS_OPTIONAL=true`) |
| Analysis | Worker runs **inline** without Redis |
| Arc data | Public RPC + Blockscout |
| Robinhood data | Public Blockscout |

```powershell
pnpm install
pnpm setup
.\scripts\dev.ps1
```

## Optional Docker

Requires Docker Desktop **running**.

```powershell
.\scripts\infra-up.ps1
```

Brings up:

- Postgres `localhost:5432` (user/pass/db: `rugkiller`)
- Redis `localhost:6379`

To use Postgres you must:

1. Set `DATABASE_URL=postgresql://rugkiller:rugkiller@localhost:5432/rugkiller`
2. Change `packages/db/prisma/schema.prisma` `provider` to `postgresql`
3. Convert JSON-as-string fields if you migrate from SQLite, or start fresh: `pnpm db:push`
4. Set `REDIS_OPTIONAL=false` if you want queue failures to be fatal

## Process layout

```
pnpm dev:api     # :4000  Fastify
pnpm dev:worker  # discovery + RH indexer + analysis + alerts
pnpm dev:web     # :3000  Next.js
```

## Health

```powershell
pnpm health
curl http://127.0.0.1:4000/health
curl http://127.0.0.1:4000/status/sources
```

## Secrets you will need later

| Secret | When |
|---|---|
| `PAYMENT_RECIPIENT_ADDRESS` | Circle Gateway x402 receiver on Arc Testnet |
| `JWT_SECRET` | Production sessions |
| `ADMIN_WALLETS` | Wallets allowed to access signed admin routes |
| `ROBINHOOD_RPC_URL` | Deeper RH RPC (optional) |

Public explorers/RPC are enough for demos.

## Windows notes

- Prefer absolute `DATABASE_URL=file:C:/.../packages/db/prisma/dev.db`
- If `prisma generate` hits `EPERM` on `query_engine-windows.dll.node`, stop API/worker, run `pnpm setup`, restart
- `scripts/dev.ps1` opens three PowerShell windows with env pre-set
