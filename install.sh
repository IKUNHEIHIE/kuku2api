#!/usr/bin/env bash
set -euo pipefail
umask 077

REPOSITORY='IKUNHEIHIE/kuku2api'
SOURCE_URL="https://codeload.github.com/$REPOSITORY/tar.gz/refs/heads/main"
NODE_URL='https://nodejs.org/dist/latest-v24.x'
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
install_dir=''
language='auto'
system_zone="${TZ:-}"
if [[ -z "$system_zone" ]]; then
  system_zone="$(readlink /etc/localtime 2>/dev/null || true)"
  system_zone="${system_zone##*zoneinfo/}"
  if [[ -z "$system_zone" && -r /etc/timezone ]]; then system_zone="$(cat /etc/timezone)"; fi
  if [[ -z "$system_zone" ]] && command -v timedatectl >/dev/null; then system_zone="$(timedatectl show --property=Timezone --value 2>/dev/null || true)"; fi
fi
system_zone="${system_zone#:}"
system_zone="${system_zone##*zoneinfo/}"
auto_language='en'
case "$system_zone" in Asia/Shanghai|Asia/Chongqing|Asia/Chungking|Asia/Harbin|Asia/Urumqi|Asia/Kashgar|Asia/Hong_Kong|Asia/Macao|Asia/Macau|Asia/Taipei|PRC|ROC|Hongkong) auto_language='zh' ;; esac
message() { if [[ "${language/auto/$auto_language}" == zh ]]; then printf '%s\n' "$1"; else printf '%s\n' "$2"; fi; }
options=()
while (($#)); do
  case "$1" in
    --dir) [[ $# -ge 2 && -n "$2" ]] || { message '--dir 需要指定目录。' '--dir requires a directory.' >&2; exit 1; }; install_dir="$2"; shift 2 ;;
    --port) [[ $# -ge 2 && "$2" =~ ^[0-9]{1,5}$ ]] && ((10#$2 >= 1 && 10#$2 <= 65535)) || { message '端口必须是 1 到 65535 之间的整数。' 'Port must be an integer between 1 and 65535.' >&2; exit 1; }; options+=("--port" "$2"); shift 2 ;;
    --lang) [[ $# -ge 2 && "$2" =~ ^(auto|zh|en)$ ]] || { message '--lang 必须为 auto、zh 或 en。' '--lang must be auto, zh or en.' >&2; exit 1; }; language="$2"; shift 2 ;;
    --no-start|--backend-only|--skip-dependencies) options+=("$1"); shift ;;
    --help) message '用法: bash install.sh [--dir 目录] [--port 端口] [--lang auto|zh|en] [--no-start] [--backend-only] [--skip-dependencies]' 'Usage: bash install.sh [--dir PATH] [--port PORT] [--lang auto|zh|en] [--no-start] [--backend-only] [--skip-dependencies]'; exit 0 ;;
    *) message "未知安装参数: $1" "Unknown option: $1" >&2; exit 1 ;;
  esac
done
if [[ -z "$install_dir" && -f "$script_dir/scripts/install.mjs" ]]; then install_dir="$script_dir"; fi
install_dir="${install_dir:-$HOME/kuku2api}"
options+=("--lang" "${language/auto/$auto_language}")
command -v curl >/dev/null || { message '请先安装 curl。' 'Please install curl first.' >&2; exit 1; }
command -v tar >/dev/null || { message '请先安装 tar。' 'Please install tar first.' >&2; exit 1; }
work="$(mktemp -d "${TMPDIR:-/tmp}/kuku2api.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT
download() { curl --fail --location --retry 3 --connect-timeout 20 --max-time 600 --proto '=https' --tlsv1.2 "$1" -o "$2"; }

if [[ ! -f "$install_dir/scripts/install.mjs" ]]; then
  if [[ -e "$install_dir" && ( ! -d "$install_dir" || -n "$(ls -A "$install_dir")" ) ]]; then
    message "拒绝覆盖非空目录: $install_dir，请用 --dir 指定其他目录。" "Refusing to overwrite a non-empty directory: $install_dir. Use --dir PATH." >&2; exit 1
  fi
  message "正在下载源码到 $install_dir ..." "Downloading source into $install_dir ..."
  download "$SOURCE_URL" "$work/source.tar.gz"
  mkdir "$work/source"
  tar -xzf "$work/source.tar.gz" -C "$work/source" --strip-components=1
  [[ -f "$work/source/scripts/install.mjs" ]] || { message '项目压缩包无效。' 'Invalid project archive.' >&2; exit 1; }
  mkdir -p -- "$(dirname -- "$install_dir")"
  if [[ -d "$install_dir" ]]; then rmdir -- "$install_dir"; fi
  mv -- "$work/source" "$install_dir"
fi
install_dir="$(cd -- "$install_dir" && pwd)"

usable_node() { "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>24||a===24&&b>=15?0:1)' >/dev/null 2>&1; }
if [[ -x "$install_dir/.runtime/node/bin/node" ]] && usable_node "$install_dir/.runtime/node/bin/node"; then
  node_bin="$install_dir/.runtime/node/bin/node"
elif command -v node >/dev/null && usable_node "$(command -v node)"; then
  node_bin="$(command -v node)"
else
  case "$(uname -s)" in Linux) platform=linux ;; Darwin) platform=darwin ;; *) message 'Windows 请使用 install.ps1；Unix 支持 Linux/macOS。' 'Use install.ps1 on Windows; supported Unix systems: Linux/macOS.' >&2; exit 1 ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) message '支持的架构: x64/arm64。' 'Supported architectures: x64/arm64.' >&2; exit 1 ;; esac
  message '正在安装并校验私有 Node.js 运行时...' 'Installing and verifying a private Node.js runtime...'
  download "$NODE_URL/SHASUMS256.txt" "$work/SHASUMS256.txt"
  archive="$(awk -v suffix="-$platform-$arch.tar.gz" 'index($2,suffix) == length($2)-length(suffix)+1 && $2 ~ /^node-v24\./ {print $2}' "$work/SHASUMS256.txt")"
  [[ "$archive" =~ ^node-v24\.[0-9]+\.[0-9]+-(linux|darwin)-(x64|arm64)\.tar\.gz$ ]] || { message '未找到匹配的官方 Node.js 程序。' 'No matching official Node.js binary.' >&2; exit 1; }
  download "$NODE_URL/$archive" "$work/$archive"
  expected="$(awk -v file="$archive" '$2==file {print $1}' "$work/SHASUMS256.txt")"
  if command -v sha256sum >/dev/null; then actual="$(sha256sum "$work/$archive" | awk '{print $1}')";
  elif command -v shasum >/dev/null; then actual="$(shasum -a 256 "$work/$archive" | awk '{print $1}')";
  else message '校验 Node.js 需要 sha256sum 或 shasum。' 'sha256sum or shasum is required to verify Node.js.' >&2; exit 1; fi
  [[ "$expected" =~ ^[a-f0-9]{64}$ && "$actual" == "$expected" ]] || { message 'Node.js 校验失败，已停止安装。' 'Node.js checksum mismatch; installation stopped.' >&2; exit 1; }
  mkdir "$work/node"
  tar -xzf "$work/$archive" -C "$work/node" --strip-components=1
  usable_node "$work/node/bin/node" || { message '下载的 Node.js 无法运行或版本低于 24.15。' 'Downloaded Node.js cannot run or is too old (minimum 24.15).' >&2; exit 1; }
  mkdir -p "$install_dir/.runtime"
  if [[ -e "$install_dir/.runtime/node" ]]; then message '现有私有运行时无效，请移走 .runtime/node 后重新安装。' 'Existing private runtime is invalid; move .runtime/node aside and rerun.' >&2; exit 1; fi
  mv "$work/node" "$install_dir/.runtime/node"
  node_bin="$install_dir/.runtime/node/bin/node"
fi
export PATH="$(dirname -- "$node_bin"):$PATH"
cd -- "$install_dir"
"$node_bin" scripts/install.mjs "${options[@]}"
