#!/usr/bin/env bash
set -euo pipefail
umask 077

REPOSITORY='IKUNHEIHIE/kuku2api'
SOURCE_URL="https://codeload.github.com/$REPOSITORY/tar.gz/refs/heads/main"
NODE_URL='https://nodejs.org/dist/latest-v24.x'
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
install_dir=''
options=()
while (($#)); do
  case "$1" in
    --dir) [[ $# -ge 2 && -n "$2" ]] || { echo '--dir requires a directory' >&2; exit 1; }; install_dir="$2"; shift 2 ;;
    --no-start|--backend-only|--skip-dependencies) options+=("$1"); shift ;;
    --help) echo 'Usage: bash install.sh [--dir PATH] [--no-start] [--backend-only] [--skip-dependencies]'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
if [[ -z "$install_dir" && -f "$script_dir/scripts/install.mjs" ]]; then install_dir="$script_dir"; fi
install_dir="${install_dir:-$HOME/kuku2api}"
command -v curl >/dev/null || { echo 'Please install curl first.' >&2; exit 1; }
command -v tar >/dev/null || { echo 'Please install tar first.' >&2; exit 1; }
work="$(mktemp -d "${TMPDIR:-/tmp}/kuku2api.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT
download() { curl --fail --location --retry 3 --connect-timeout 20 --max-time 600 --proto '=https' --tlsv1.2 "$1" -o "$2"; }

if [[ ! -f "$install_dir/scripts/install.mjs" ]]; then
  if [[ -e "$install_dir" && ( ! -d "$install_dir" || -n "$(ls -A "$install_dir")" ) ]]; then
    echo "Refusing to overwrite a non-empty directory: $install_dir. Use --dir PATH." >&2; exit 1
  fi
  download "$SOURCE_URL" "$work/source.tar.gz"
  mkdir "$work/source"
  tar -xzf "$work/source.tar.gz" -C "$work/source" --strip-components=1
  [[ -f "$work/source/scripts/install.mjs" ]] || { echo 'Invalid project archive' >&2; exit 1; }
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
  case "$(uname -s)" in Linux) platform=linux ;; Darwin) platform=darwin ;; *) echo 'Use install.ps1 on Windows; supported Unix systems: Linux/macOS.' >&2; exit 1 ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) echo 'Supported architectures: x64/arm64.' >&2; exit 1 ;; esac
  download "$NODE_URL/SHASUMS256.txt" "$work/SHASUMS256.txt"
  archive="$(awk -v suffix="-$platform-$arch.tar.gz" 'index($2,suffix) == length($2)-length(suffix)+1 && $2 ~ /^node-v24\./ {print $2}' "$work/SHASUMS256.txt")"
  [[ "$archive" =~ ^node-v24\.[0-9]+\.[0-9]+-(linux|darwin)-(x64|arm64)\.tar\.gz$ ]] || { echo 'No matching official Node.js binary' >&2; exit 1; }
  download "$NODE_URL/$archive" "$work/$archive"
  expected="$(awk -v file="$archive" '$2==file {print $1}' "$work/SHASUMS256.txt")"
  if command -v sha256sum >/dev/null; then actual="$(sha256sum "$work/$archive" | awk '{print $1}')";
  elif command -v shasum >/dev/null; then actual="$(shasum -a 256 "$work/$archive" | awk '{print $1}')";
  else echo 'sha256sum or shasum is required to verify Node.js.' >&2; exit 1; fi
  [[ "$expected" =~ ^[a-f0-9]{64}$ && "$actual" == "$expected" ]] || { echo 'Node.js checksum mismatch; installation stopped.' >&2; exit 1; }
  mkdir "$work/node"
  tar -xzf "$work/$archive" -C "$work/node" --strip-components=1
  usable_node "$work/node/bin/node" || { echo 'Downloaded Node.js cannot run or is too old (minimum 24.15).' >&2; exit 1; }
  mkdir -p "$install_dir/.runtime"
  if [[ -e "$install_dir/.runtime/node" ]]; then echo 'Existing private runtime is invalid; move .runtime/node aside and rerun.' >&2; exit 1; fi
  mv "$work/node" "$install_dir/.runtime/node"
  node_bin="$install_dir/.runtime/node/bin/node"
fi
export PATH="$(dirname -- "$node_bin"):$PATH"
cd -- "$install_dir"
"$node_bin" scripts/install.mjs "${options[@]}"
