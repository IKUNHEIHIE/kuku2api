$ErrorActionPreference = 'Stop'
$taskNode = Join-Path $PSScriptRoot '.runtime/node/node.exe'
if (-not (Test-Path -LiteralPath $taskNode)) { $taskNode = (Get-Command node.exe -ErrorAction Stop).Source }
$env:KUKU_INSTALLER_QUIET = '1'
& $taskNode (Join-Path $PSScriptRoot 'scripts/manage.mjs') --root $PSScriptRoot --start @args
exit $LASTEXITCODE
