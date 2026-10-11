#!/usr/bin/env bash
set -euo pipefail
umask 077
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
bootstrap="$(mktemp "${TMPDIR:-/tmp}/kuku2api-upgrade.XXXXXX")"
trap 'rm -f -- "$bootstrap"' EXIT
curl -fsSL --retry 3 --connect-timeout 20 --max-time 120 --proto '=https' --tlsv1.2 https://raw.githubusercontent.com/IKUNHEIHIE/kuku2api/main/install.sh -o "$bootstrap"
bash "$bootstrap" --dir "$root" --upgrade "$@"
