# Optional: start Postgres + Redis via Docker
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

Write-Host "Starting Docker services (postgres, redis)..." -ForegroundColor Cyan
docker compose up -d
if ($LASTEXITCODE -ne 0) {
  Write-Host "Docker failed. Local mode works with SQLite + REDIS_OPTIONAL=true (no Docker required)." -ForegroundColor Yellow
  exit 1
}

docker compose ps
Write-Host ""
Write-Host "If you want Postgres instead of SQLite:" -ForegroundColor Cyan
Write-Host '  1. Set DATABASE_URL=postgresql://rugkiller:rugkiller@localhost:5432/rugkiller'
Write-Host "  2. Switch packages/db/prisma/schema.prisma provider to postgresql"
Write-Host "  3. pnpm db:push"
