param(
  [Parameter(Mandatory = $true)]
  [string] $Url,

  [Parameter(Mandatory = $true)]
  [string] $Repo,

  [ValidateSet("openai", "deepseek", "openai-compatible", "anthropic")]
  [string] $Provider = "openai",

  [string] $ApiKey = "",
  [string] $BaseUrl = "",
  [string] $SmallModel = "",
  [string] $MediumModel = "",
  [string] $LargeModel = "",
  [string] $OutboundProxy = "",
  [string] $Output = "",
  [string] $Workspace = "",
  [switch] $PipelineTesting,
  [switch] $Debug,
  [switch] $Monitor
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Find-CommandOrDockerBundled([string] $Name) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  if ($Name -eq "docker") {
    $bundled = "C:\Program Files\Docker\Docker\resources\bin\docker.exe"
    if (Test-Path $bundled) { return $bundled }
  }

  return $null
}

$docker = Find-CommandOrDockerBundled "docker"
if (-not $docker) {
  Write-Error "Docker was not found. Install Docker Desktop first, then rerun this script."
}

try {
  & $docker info *> $null
} catch {
  $desktop = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
  if (Test-Path $desktop) {
    Start-Process -FilePath $desktop -WindowStyle Hidden
    Write-Host "Docker Desktop was started. Wait until the engine is running, then rerun this script."
  } else {
    Write-Host "Docker Engine is not running."
  }
  Write-Host "On a fresh Windows host, Docker Desktop may require WSL/VirtualMachinePlatform enabled from an elevated PowerShell and a reboot."
  exit 1
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Error "Node.js was not found. Install Node.js 18+ first."
}

$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpm) {
  npm install -g pnpm
}

if ($Provider -eq "anthropic") {
  if (-not $env:ANTHROPIC_API_KEY -and $ApiKey) {
    $env:ANTHROPIC_API_KEY = $ApiKey
  }
} else {
  if (-not $ApiKey) {
    if ($Provider -eq "deepseek") { $ApiKey = $env:DEEPSEEK_API_KEY }
    if (-not $ApiKey) { $ApiKey = $env:OPENAI_COMPAT_API_KEY }
    if (-not $ApiKey) { $ApiKey = $env:OPENAI_API_KEY }
  }

  if (-not $ApiKey) {
    Write-Error "No API key provided. Pass -ApiKey or set OPENAI_COMPAT_API_KEY / OPENAI_API_KEY / DEEPSEEK_API_KEY."
  }

  $env:SHANNON_AI_PROVIDER = $Provider
  $env:OPENAI_COMPAT_API_KEY = $ApiKey

  if ($OutboundProxy) {
    $env:OUTBOUND_PROXY = $OutboundProxy
    $env:FORWARDER_PORT = "9001"
    $forwarderDeps = Join-Path $Root "node_modules\undici"
    if (-not (Test-Path $forwarderDeps)) {
      pnpm add -D undici
    }
    Start-Process -FilePath "node" `
      -ArgumentList @((Join-Path $Root "scripts\openai-forwarder.mjs")) `
      -WorkingDirectory $Root `
      -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $Root "workspaces\openai-forwarder.out.log") `
      -RedirectStandardError (Join-Path $Root "workspaces\openai-forwarder.err.log")
    Start-Sleep -Seconds 2
    $BaseUrl = "http://127.0.0.1:9001/v1"
  }

  if ($BaseUrl) { $env:OPENAI_COMPAT_BASE_URL = $BaseUrl }
  if ($SmallModel) { $env:OPENAI_COMPAT_SMALL_MODEL = $SmallModel }
  if ($MediumModel) { $env:OPENAI_COMPAT_MEDIUM_MODEL = $MediumModel }
  if ($LargeModel) { $env:OPENAI_COMPAT_LARGE_MODEL = $LargeModel }
}

if (-not (Test-Path "node_modules")) {
  pnpm install
}

pnpm build

$args = @("apps/cli/dist/index.mjs", "start", "-u", $Url, "-r", (Resolve-Path $Repo).Path)
if ($Output) {
  New-Item -ItemType Directory -Force $Output | Out-Null
  $args += @("-o", (Resolve-Path -LiteralPath $Output).Path)
}
if ($Workspace) { $args += @("-w", $Workspace) }
if ($PipelineTesting) { $args += "--pipeline-testing" }
if ($Debug) { $args += "--debug" }

node @args

if ($Monitor) {
  if (-not $Workspace) {
    Write-Host "监控端需要固定 workspace 名称。请加 -Workspace my-scan 后再使用 -Monitor。"
    exit 0
  }
  node apps/cli/dist/index.mjs monitor $Workspace
}
