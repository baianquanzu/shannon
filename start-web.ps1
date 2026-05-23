param(
  [int] $Port = 8787,
  [string] $HostName = "127.0.0.1"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  npm install -g pnpm
}

if (-not (Test-Path "node_modules")) {
  pnpm install
}

pnpm build

$env:SHANNON_WEB_PORT = "$Port"
$env:SHANNON_WEB_HOST = $HostName

Write-Host "Starting Shannon Web dashboard..."
Write-Host "URL: http://$HostName`:$Port"

node apps/web/dist/server.js
