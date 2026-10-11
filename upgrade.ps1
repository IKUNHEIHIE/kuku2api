[CmdletBinding()]
param(
  [ValidateRange(1, 65535)][int]$Port,
  [ValidateSet('auto', 'zh', 'en')][string]$Lang = 'auto',
  [switch]$NoStart,
  [switch]$BackendOnly
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$taskBootstrap = Join-Path ([IO.Path]::GetTempPath()) ('kuku2api-upgrade-' + [guid]::NewGuid().ToString('N') + '.ps1')
try {
  Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/IKUNHEIHIE/kuku2api/main/install.ps1' -OutFile $taskBootstrap -UseBasicParsing -TimeoutSec 120
  & $taskBootstrap -InstallDir $PSScriptRoot -Upgrade @PSBoundParameters
  if ($LASTEXITCODE -ne 0) { throw "Upgrade failed (exit $LASTEXITCODE)" }
} finally {
  Remove-Item -LiteralPath $taskBootstrap -Force -ErrorAction SilentlyContinue
}
