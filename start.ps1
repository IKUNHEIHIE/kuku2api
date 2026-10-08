$ErrorActionPreference = 'Stop'
$taskNode = Join-Path $PSScriptRoot '.runtime/node/node.exe'
if (-not (Test-Path -LiteralPath $taskNode)) { $taskNode = (Get-Command node.exe -ErrorAction Stop).Source }
& $taskNode (Join-Path $PSScriptRoot 'scripts/start.mjs')
exit $LASTEXITCODE
