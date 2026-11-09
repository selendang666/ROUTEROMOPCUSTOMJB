#!/usr/bin/env bash
# Oh My Omop - Router — Unix setup (macOS/Linux thin wrapper)
# Prefer: bun run setup  (cross-OS). This is just a convenience for shell users.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$DIR"
exec bun run setup "$@"
