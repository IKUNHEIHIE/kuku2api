[CmdletBinding()]
param(
  [string]$InstallDir,
  [ValidateRange(1, 65535)][int]$Port,
  [ValidateSet('auto', 'zh', 'en')][string]$Lang = 'auto',
  [switch]$Upgrade,
  [switch]$Start,
  [switch]$Restart,
  [switch]$Install,
  [switch]$NoStart,
  [switch]$BackendOnly,
  [switch]$SkipDependencies,
  [switch]$BuildFromSource
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$taskRepository = 'IKUNHEIHIE/kuku2api'
$taskAction = 'auto'
$taskActions = @()
if ($Upgrade) { $taskActions += 'upgrade' }
if ($Start) { $taskActions += 'start' }
if ($Restart) { $taskActions += 'restart' }
if ($Install) { $taskActions += 'install' }
if ($taskActions.Count -gt 1) { throw 'Choose one action / 请选择一个操作' }
if ($taskActions.Count -eq 1) { $taskAction = $taskActions[0] }
$taskZone = if ($env:TZ) { ($env:TZ -replace '^:', '') -replace '^.*zoneinfo/', '' } else { [TimeZoneInfo]::Local.Id }
if ($Lang -eq 'auto') {
  $Lang = if ($taskZone -match '^(Asia/(Shanghai|Chongqing|Chungking|Harbin|Urumqi|Kashgar|Hong_Kong|Macao|Macau|Taipei)|PRC|ROC|Hongkong|China Standard Time|Taipei Standard Time)$') { 'zh' } else { 'en' }
}
function Get-TaskMessage([string]$Chinese, [string]$English) {
  if ($Lang -eq 'zh') { return $Chinese }
  return $English
}
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
function Get-TaskSha256([string]$File) {
  $taskStream = [IO.File]::OpenRead($File)
  $taskHasher = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($taskHasher.ComputeHash($taskStream)).Replace('-', '').ToLowerInvariant() }
  finally { $taskHasher.Dispose(); $taskStream.Dispose() }
}
function Test-TaskNode([string]$Executable) {
  if (-not $Executable -or -not (Test-Path -LiteralPath $Executable)) { return $false }
  try {
    & $Executable -e 'const [a,b]=process.versions.node.split(''.'').map(Number);process.exit(a>24||a===24&&b>=15?0:1)' *> $null
    return $LASTEXITCODE -eq 0
  } catch { return $false }
}
function Get-TaskSource {
  if (-not $BuildFromSource -and -not $BackendOnly) {
    $taskReleaseUrl = "https://github.com/$taskRepository/releases/latest/download"
    $taskChecksum = Join-Path $taskTemp 'release-checksums.txt'
    $taskZip = Join-Path $taskTemp 'release.zip'
    try { Get-TaskDownload "$taskReleaseUrl/SHA256SUMS" $taskChecksum }
    catch { throw (Get-TaskMessage '预编译发布包暂不可用，请稍后重试；不会转为本机构建。' 'Prebuilt release unavailable; retry later. No local build will run.') }
    Get-TaskDownload "$taskReleaseUrl/kuku2api.zip" $taskZip
    $taskMatch = @(Get-Content -LiteralPath $taskChecksum | Select-String -Pattern '^([a-f0-9]{64})\s+kuku2api\.zip$')
    if ($taskMatch.Count -ne 1 -or (Get-TaskSha256 $taskZip) -ne $taskMatch[0].Matches[0].Groups[1].Value) { throw (Get-TaskMessage '发布包校验失败，请重新运行；不会转为本机构建。' 'Release checksum mismatch; rerun the installer. No local build will run.') }
    $taskSourceDirectory = Join-Path $taskTemp 'source'
    Expand-Archive -LiteralPath $taskZip -DestinationPath $taskSourceDirectory
    foreach ($taskRequired in @('release.json','ui/dist/index.html','scripts/prebuilt.mjs','scripts/manage.mjs','package.json')) {
      if (-not (Test-Path -LiteralPath (Join-Path $taskSourceDirectory $taskRequired))) { throw (Get-TaskMessage '预编译发布包不完整，已停止安装。' 'Incomplete prebuilt release; installation stopped.') }
    }
    return $taskSourceDirectory
  }
  $taskZip = Join-Path $taskTemp 'source.zip'
  Get-TaskDownload "https://codeload.github.com/$taskRepository/zip/refs/heads/main" $taskZip
  Expand-Archive -LiteralPath $taskZip -DestinationPath (Join-Path $taskTemp 'source')
  $taskSourceDirectory = Join-Path $taskTemp 'source/kuku2api-main'
  if (-not (Test-Path -LiteralPath (Join-Path $taskSourceDirectory 'scripts/manage.mjs'))) { throw (Get-TaskMessage '项目压缩包无效或版本过旧，请稍后重试。' 'Invalid or outdated project archive; retry shortly.') }
  return $taskSourceDirectory
}
try {
  $taskExisting = (Test-Path -LiteralPath (Join-Path $InstallDir 'scripts/install.mjs')) -or (Test-Path -LiteralPath (Join-Path $InstallDir 'src/server.mjs'))
  if (-not $taskExisting -and $taskAction -in @('start', 'restart')) { throw (Get-TaskMessage '尚未安装，请先运行安装器。' 'Not installed; run the installer first.') }
  if (-not (Test-Path -LiteralPath (Join-Path $InstallDir 'scripts/install.mjs'))) {
    if ($taskExisting) { $taskAction = 'upgrade' }
    else {
    if (Test-Path -LiteralPath $InstallDir) {
      if (-not (Test-Path -LiteralPath $InstallDir -PathType Container) -or @(Get-ChildItem -LiteralPath $InstallDir -Force).Count -gt 0) {
        throw (Get-TaskMessage '拒绝覆盖非空目录，请用 -InstallDir 指定其他目录。' 'Refusing to overwrite a non-empty directory. Choose another -InstallDir.')
      }
    }
    $taskSource = Get-TaskSource
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    Get-ChildItem -LiteralPath $taskSource -Force | Copy-Item -Destination $InstallDir -Recurse -Force
    $taskAction = 'install'
    }
  }
  $taskNode = Join-Path $InstallDir '.runtime/node/node.exe'
  if (-not (Test-TaskNode $taskNode)) {
    $taskSystemNode = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($taskSystemNode -and (Test-TaskNode $taskSystemNode.Source)) { $taskNode = $taskSystemNode.Source }
    else {
      $taskArchitecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
      $taskArchitecture = $taskArchitecture.ToLowerInvariant() -replace '^amd64$','x64'
      if ($taskArchitecture -notin @('x64','arm64')) { throw (Get-TaskMessage 'Windows 支持的架构: x64/arm64。' 'Supported Windows architectures: x64/arm64') }
      $taskNodeUrl = 'https://nodejs.org/dist/latest-v24.x'
      $taskChecksumFile = Join-Path $taskTemp 'SHASUMS256.txt'
      Get-TaskDownload "$taskNodeUrl/SHASUMS256.txt" $taskChecksumFile
      $taskPattern = '^([a-f0-9]{64})\s+(node-v24\.\d+\.\d+-win-' + $taskArchitecture + '\.zip)$'
      $taskMatch = @(Get-Content -LiteralPath $taskChecksumFile | Select-String -Pattern $taskPattern)
      if ($taskMatch.Count -ne 1) { throw (Get-TaskMessage '未找到匹配的官方 Node.js 程序。' 'No matching official Node.js binary') }
      $taskExpected = $taskMatch[0].Matches[0].Groups[1].Value
      $taskArchive = $taskMatch[0].Matches[0].Groups[2].Value
      $taskNodeZip = Join-Path $taskTemp $taskArchive
      Get-TaskDownload "$taskNodeUrl/$taskArchive" $taskNodeZip
      if ((Get-TaskSha256 $taskNodeZip) -ne $taskExpected) { throw (Get-TaskMessage 'Node.js 校验失败，已停止安装。' 'Node.js checksum mismatch; installation stopped') }
      $taskNodeStage = Join-Path $taskTemp 'node'
      Expand-Archive -LiteralPath $taskNodeZip -DestinationPath $taskNodeStage
      $taskExtracted = Join-Path $taskNodeStage ($taskArchive -replace '\.zip$','')
      if (-not (Test-TaskNode (Join-Path $taskExtracted 'node.exe'))) { throw (Get-TaskMessage '下载的 Node.js 无法运行或版本低于 24.15。' 'Downloaded Node.js cannot run or is too old (minimum 24.15)') }
      $taskRuntime = Join-Path $InstallDir '.runtime/node'
      if (Test-Path -LiteralPath $taskRuntime) { throw (Get-TaskMessage '现有私有运行时无效，请移走 .runtime/node 后重新安装。' 'Existing private runtime is invalid; move .runtime/node aside and rerun') }
      New-Item -ItemType Directory -Path (Split-Path $taskRuntime -Parent) -Force | Out-Null
      Move-Item -LiteralPath $taskExtracted -Destination $taskRuntime
      $taskNode = Join-Path $taskRuntime 'node.exe'
    }
  }
  $taskInstallerSource = if (Test-Path -LiteralPath (Join-Path $InstallDir 'scripts/install.mjs')) { Get-Content -LiteralPath (Join-Path $InstallDir 'scripts/install.mjs') -Raw } else { '' }
  $taskCompatible = $taskInstallerSource.Contains('export const INSTALLER_PROTOCOL = 4;') -and
      (Test-Path -LiteralPath (Join-Path $InstallDir 'scripts/manage.mjs')) -and
      (Test-Path -LiteralPath (Join-Path $InstallDir 'scripts/service.mjs')) -and
      (Test-Path -LiteralPath (Join-Path $InstallDir 'scripts/install-language.mjs')) -and
      (Test-Path -LiteralPath (Join-Path $InstallDir 'scripts/prebuilt.mjs')) -and
      (Test-Path -LiteralPath (Join-Path $InstallDir 'scripts/install-output.mjs')) -and
      (Test-Path -LiteralPath (Join-Path $InstallDir 'src/listen-port.mjs'))
  if ($taskAction -eq 'auto') {
    $taskAction = if (-not $taskCompatible -or [IO.Path]::GetFullPath($PSScriptRoot) -ne $InstallDir -or (-not $BuildFromSource -and -not $BackendOnly)) { 'upgrade' } else { 'install' }
  }
  if ($taskAction -in @('start', 'restart') -and (-not $taskCompatible)) { $taskAction = 'upgrade' }
  if ($taskAction -eq 'install' -and (-not $taskCompatible)) {
    throw (Get-TaskMessage '源码目录版本过旧或不完整，请使用 -Upgrade 自动升级；数据库和令牌尚未被改动。' 'Outdated or incomplete source directory. Use -Upgrade to update automatically; the database and token have not been changed.')
  }
  $taskArgs = @('--lang', $Lang)
  if ($PSBoundParameters.ContainsKey('Port')) { $taskArgs += @('--port', "$Port") }
  if ($NoStart) { $taskArgs += '--no-start' }
  if ($BackendOnly) { $taskArgs += '--backend-only' }
  if ($SkipDependencies) { $taskArgs += '--skip-dependencies' }
  if ($BuildFromSource) { $taskArgs += '--build-from-source' }
  $env:PATH = (Split-Path $taskNode -Parent) + [IO.Path]::PathSeparator + $env:PATH
  $env:KUKU_INSTALLER_QUIET = '1'
  if ($taskAction -eq 'upgrade') {
    $taskSource = Get-TaskSource
    & $taskNode (Join-Path $taskSource 'scripts/manage.mjs') --root $InstallDir --upgrade @taskArgs
  } elseif ($taskAction -in @('start', 'restart')) {
    $taskManager = Join-Path $InstallDir 'scripts/manage.mjs'
    if (-not (Test-Path -LiteralPath $taskManager)) { $taskSource = Get-TaskSource; $taskManager = Join-Path $taskSource 'scripts/manage.mjs' }
    & $taskNode $taskManager --root $InstallDir "--$taskAction" @taskArgs
  } else {
    & $taskNode (Join-Path $InstallDir 'scripts/install.mjs') @taskArgs
  }
  if ($LASTEXITCODE -ne 0) { throw (Get-TaskMessage "安装失败（退出码 $LASTEXITCODE），请修复后重新安装。" "Installation failed (exit $LASTEXITCODE). Fix the error and rerun.") }
} finally {
  # Only remove the unique temporary directory created by this invocation.
  $taskResolvedTemp = [IO.Path]::GetFullPath($taskTemp)
  $taskTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  if (-not $taskResolvedTemp.StartsWith($taskTempRoot, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path $taskResolvedTemp -Leaf) -notmatch '^kuku2api-[a-f0-9]{32}$') { throw (Get-TaskMessage '临时目录清理路径不安全。' 'Unsafe temporary directory cleanup path') }
  Remove-Item -LiteralPath $taskResolvedTemp -Recurse -Force -ErrorAction SilentlyContinue
}
