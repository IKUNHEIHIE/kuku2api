#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ -x "$root/.runtime/node/bin/node" ]]; then node_bin="$root/.runtime/node/bin/node"; else node_bin=node; fi
exec "$node_bin" "$root/scripts/start.mjs"
