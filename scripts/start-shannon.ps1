param(
  [string] $Url = "",
  [string] $Repo = "",
  [ValidateSet("openai", "deepseek", "openai-compatible", "anthropic")]
  [string] $Provider = "deepseek",
  [string] $ApiKey = "",
  [string] $BaseUrl = "",
  [string] $SmallModel = "",
  [string] $MediumModel = "",
  [string] $LargeModel = "",
  [int] $Port = 8787,
  [string] $HostName = "127.0.0.1"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Set-EnvValue([string] $Name, [string] $Value) {
  if ($Value) {
    [Environment]::SetEnvironmentVariable($Name, $Value, "Process")
  }
}

$env:SHANNON_AI_PROVIDER = $Provider
if ($ApiKey) {
  $env:OPENAI_COMPAT_API_KEY = $ApiKey
  if ($Provider -eq "deepseek") {
    $env:DEEPSEEK_API_KEY = $ApiKey
  }
}
Set-EnvValue "OPENAI_COMPAT_BASE_URL" $BaseUrl
Set-EnvValue "OPENAI_COMPAT_SMALL_MODEL" $SmallModel
Set-EnvValue "OPENAI_COMPAT_MEDIUM_MODEL" $MediumModel
Set-EnvValue "OPENAI_COMPAT_LARGE_MODEL" $LargeModel

if ($Url -or $Repo) {
  Write-Host "This no-container version uses the Web dashboard for creating scan tasks."
  Write-Host "Open the dashboard, configure AI, upload the code package, and choose source-only, existing URL, or remote Linux mode."
}

powershell -ExecutionPolicy Bypass -File (Join-Path $Root "start-web.ps1") -Port $Port -HostName $HostName
