[CmdletBinding()]
param(
  [string]$InstallDir,
  [switch]$NoStart,
  [switch]$BackendOnly,
  [switch]$SkipDependencies
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$taskRepository = 'IKUNHEIHIE/kuku2api'
if (-not $InstallDir) {
  if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'scripts/install.mjs')) { $InstallDir = $PSScriptRoot }
  else { $InstallDir = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'kuku2api' }
}
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$taskTemp = Join-Path ([IO.Path]::GetTempPath()) ('kuku2api-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskTemp | Out-Null
function Get-TaskDownload([string]$Url, [string]$Destination) {
  Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing -TimeoutSec 600
}
function Test-TaskNode([string]$Executable) {
  if (-not $Executable -or -not (Test-Path -LiteralPath $Executable)) { return $false }
  try {
    & $Executable -e 'const [a,b]=process.versions.node.split(''.'').map(Number);process.exit(a>24||a===24&&b>=15?0:1)' *> $null
    return $LASTEXITCODE -eq 0
  } catch { return $false }
}
try {
  if (-not (Test-Path -LiteralPath (Join-Path $InstallDir 'scripts/install.mjs'))) {
    if (Test-Path -LiteralPath $InstallDir) {
      if (-not (Test-Path -LiteralPath $InstallDir -PathType Container) -or @(Get-ChildItem -LiteralPath $InstallDir -Force).Count -gt 0) {
        throw 'Refusing to overwrite a non-empty directory. Choose another -InstallDir.'
      }
    }
    $taskZip = Join-Path $taskTemp 'source.zip'
    Get-TaskDownload "https://codeload.github.com/$taskRepository/zip/refs/heads/main" $taskZip
    Expand-Archive -LiteralPath $taskZip -DestinationPath (Join-Path $taskTemp 'source')
    $taskSource = Join-Path $taskTemp 'source/kuku2api-main'
    if (-not (Test-Path -LiteralPath (Join-Path $taskSource 'scripts/install.mjs'))) { throw 'Invalid project archive' }
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    Get-ChildItem -LiteralPath $taskSource -Force | Copy-Item -Destination $InstallDir -Recurse -Force
  }
  $taskNode = Join-Path $InstallDir '.runtime/node/node.exe'
  if (-not (Test-TaskNode $taskNode)) {
    $taskSystemNode = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($taskSystemNode -and (Test-TaskNode $taskSystemNode.Source)) { $taskNode = $taskSystemNode.Source }
    else {
      $taskArchitecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
      $taskArchitecture = $taskArchitecture.ToLowerInvariant() -replace '^amd64$','x64'
      if ($taskArchitecture -notin @('x64','arm64')) { throw 'Supported Windows architectures: x64/arm64' }
      $taskNodeUrl = 'https://nodejs.org/dist/latest-v24.x'
      $taskChecksumFile = Join-Path $taskTemp 'SHASUMS256.txt'
      Get-TaskDownload "$taskNodeUrl/SHASUMS256.txt" $taskChecksumFile
      $taskPattern = '^([a-f0-9]{64})\s+(node-v24\.\d+\.\d+-win-' + $taskArchitecture + '\.zip)$'
      $taskMatch = @(Get-Content -LiteralPath $taskChecksumFile | Select-String -Pattern $taskPattern)
      if ($taskMatch.Count -ne 1) { throw 'No matching official Node.js binary' }
      $taskExpected = $taskMatch[0].Matches[0].Groups[1].Value
      $taskArchive = $taskMatch[0].Matches[0].Groups[2].Value
      $taskNodeZip = Join-Path $taskTemp $taskArchive
      Get-TaskDownload "$taskNodeUrl/$taskArchive" $taskNodeZip
      if ((Get-FileHash -LiteralPath $taskNodeZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskExpected) { throw 'Node.js checksum mismatch; installation stopped' }
      $taskNodeStage = Join-Path $taskTemp 'node'
      Expand-Archive -LiteralPath $taskNodeZip -DestinationPath $taskNodeStage
      $taskExtracted = Join-Path $taskNodeStage ($taskArchive -replace '\.zip$','')
      if (-not (Test-TaskNode (Join-Path $taskExtracted 'node.exe'))) { throw 'Downloaded Node.js cannot run or is too old (minimum 24.15)' }
      $taskRuntime = Join-Path $InstallDir '.runtime/node'
      if (Test-Path -LiteralPath $taskRuntime) { throw 'Existing private runtime is invalid; move .runtime/node aside and rerun' }
      New-Item -ItemType Directory -Path (Split-Path $taskRuntime -Parent) -Force | Out-Null
      Move-Item -LiteralPath $taskExtracted -Destination $taskRuntime
      $taskNode = Join-Path $taskRuntime 'node.exe'
    }
  }
  $taskArgs = @()
  if ($NoStart) { $taskArgs += '--no-start' }
  if ($BackendOnly) { $taskArgs += '--backend-only' }
  if ($SkipDependencies) { $taskArgs += '--skip-dependencies' }
  $env:PATH = (Split-Path $taskNode -Parent) + [IO.Path]::PathSeparator + $env:PATH
  & $taskNode (Join-Path $InstallDir 'scripts/install.mjs') @taskArgs
  if ($LASTEXITCODE -ne 0) { throw "Installation failed (exit $LASTEXITCODE). Fix the error and rerun." }
} finally {
  # Only remove the unique temporary directory created by this invocation.
  $taskResolvedTemp = [IO.Path]::GetFullPath($taskTemp)
  $taskTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  if (-not $taskResolvedTemp.StartsWith($taskTempRoot, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path $taskResolvedTemp -Leaf) -notmatch '^kuku2api-[a-f0-9]{32}$') { throw 'Unsafe temporary directory cleanup path' }
  Remove-Item -LiteralPath $taskResolvedTemp -Recurse -Force -ErrorAction SilentlyContinue
}
