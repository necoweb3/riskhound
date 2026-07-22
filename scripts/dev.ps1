# RugKiller local dev launcher (Windows PowerShell)
# Starts API + worker + web in separate windows.

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$Db = (Join-Path $Root "packages\db\prisma\dev.db") -replace '\\', '/'
$env:DATABASE_URL = "file:$Db"
$env:REDIS_OPTIONAL = "true"
$env:NEXT_PUBLIC_API_URL = "http://localhost:4000"
$env:NODE_ENV = "development"

Write-Host "Running setup..." -ForegroundColor Cyan
node scripts/setup.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

function Start-DevWindow([string]$Title, [string]$Command) {
  Start-Process powershell -ArgumentList @(
    "-NoExit",
    "-Command",
    "Set-Location '$Root'; `$env:DATABASE_URL='$($env:DATABASE_URL)'; `$env:REDIS_OPTIONAL='true'; `$env:NEXT_PUBLIC_API_URL='http://localhost:4000'; `$env:NODE_ENV='development'; Write-Host '$Title' -ForegroundColor Green; $Command"
  )
}

Start-DevWindow "RugKiller API" "pnpm dev:api"
Start-Sleep -Seconds 1
Start-DevWindow "RugKiller Worker" "pnpm dev:worker"
Start-Sleep -Seconds 1
Start-DevWindow "RugKiller Web" "pnpm dev:web"

Write-Host ""
Write-Host "Started three terminals." -ForegroundColor Green
Write-Host "  Web  http://localhost:3000"
Write-Host "  API  http://localhost:4000"
Write-Host ""
