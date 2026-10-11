[CmdletBinding()]
param(
  [string]$InstallDir,
  [ValidateRange(1, 65535)][int]$Port,
  [ValidateSet('auto', 'zh', 'en')][string]$Lang = 'auto',
  [switch]$NoStart,
  [switch]$BackendOnly,
  [switch]$SkipDependencies
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$taskRepository = 'IKUNHEIHIE/kuku2api'
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
        throw (Get-TaskMessage '拒绝覆盖非空目录，请用 -InstallDir 指定其他目录。' 'Refusing to overwrite a non-empty directory. Choose another -InstallDir.')
      }
    }
    $taskZip = Join-Path $taskTemp 'source.zip'
    Write-Host (Get-TaskMessage "正在下载源码到 $InstallDir ..." "Downloading source into $InstallDir ...")
    Get-TaskDownload "https://codeload.github.com/$taskRepository/zip/refs/heads/main" $taskZip
    Expand-Archive -LiteralPath $taskZip -DestinationPath (Join-Path $taskTemp 'source')
    $taskSource = Join-Path $taskTemp 'source/kuku2api-main'
    if (-not (Test-Path -LiteralPath (Join-Path $taskSource 'scripts/install.mjs'))) { throw (Get-TaskMessage '项目压缩包无效。' 'Invalid project archive.') }
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
      if ($taskArchitecture -notin @('x64','arm64')) { throw (Get-TaskMessage 'Windows 支持的架构: x64/arm64。' 'Supported Windows architectures: x64/arm64') }
      Write-Host (Get-TaskMessage '正在安装并校验私有 Node.js 运行时...' 'Installing and verifying a private Node.js runtime...')
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
      if ((Get-FileHash -LiteralPath $taskNodeZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskExpected) { throw (Get-TaskMessage 'Node.js 校验失败，已停止安装。' 'Node.js checksum mismatch; installation stopped') }
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
  $taskInstallerSource = Get-Content -LiteralPath (Join-Path $InstallDir 'scripts/install.mjs') -Raw
  if (-not $taskInstallerSource.Contains('export const INSTALLER_PROTOCOL = 2;') -or
      -not (Test-Path -LiteralPath (Join-Path $InstallDir 'scripts/install-language.mjs')) -or
      -not (Test-Path -LiteralPath (Join-Path $InstallDir 'src/listen-port.mjs'))) {
    Write-Host (Get-TaskMessage "检测到旧版或不完整的源码目录：$InstallDir" "Outdated or incomplete source directory detected: $InstallDir")
    Write-Host (Get-TaskMessage '请先停止旧服务并备份自定义源码，再更新该目录的完整源码。Git 安装可运行 git pull --ff-only；压缩包安装请重新下载并解压完整源码。保留 data 目录、数据库和令牌文件。' 'Stop the old service and back up custom code, then update the complete source in this directory. Git installs can use git pull --ff-only; archive installs must download and extract the complete source again. Preserve data, databases and token files.')
    throw (Get-TaskMessage '安装入口与源码版本不匹配，已停止；数据库和令牌尚未被改动。' 'Installer/source version mismatch; stopped without changing the database or token.')
  }
  $taskArgs = @('--lang', $Lang)
  if ($PSBoundParameters.ContainsKey('Port')) { $taskArgs += @('--port', "$Port") }
  if ($NoStart) { $taskArgs += '--no-start' }
  if ($BackendOnly) { $taskArgs += '--backend-only' }
  if ($SkipDependencies) { $taskArgs += '--skip-dependencies' }
  $env:PATH = (Split-Path $taskNode -Parent) + [IO.Path]::PathSeparator + $env:PATH
  & $taskNode (Join-Path $InstallDir 'scripts/install.mjs') @taskArgs
  if ($LASTEXITCODE -ne 0) { throw (Get-TaskMessage "安装失败（退出码 $LASTEXITCODE），请修复后重新安装。" "Installation failed (exit $LASTEXITCODE). Fix the error and rerun.") }
} finally {
  # Only remove the unique temporary directory created by this invocation.
  $taskResolvedTemp = [IO.Path]::GetFullPath($taskTemp)
  $taskTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  if (-not $taskResolvedTemp.StartsWith($taskTempRoot, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path $taskResolvedTemp -Leaf) -notmatch '^kuku2api-[a-f0-9]{32}$') { throw (Get-TaskMessage '临时目录清理路径不安全。' 'Unsafe temporary directory cleanup path') }
  Remove-Item -LiteralPath $taskResolvedTemp -Recurse -Force -ErrorAction SilentlyContinue
}
