#!/bin/sh
set -eu
umask 077

# Oh My Omop - Router: PostgreSQL config authority with bounded SQLite telemetry fallback.
# This entrypoint is intentionally minimal and Windows bind-mount safe:
# - only fixes ownership on the dedicated telemetry directory before dropping privileges
# - handles a mounted /app/data volume, whose mount can hide image-layer ownership
# - uses gosu to run the application as non-root ohmyomop-router
# - preserves SIGTERM via exec so runtime lifecycle handles drain correctly

if [ "$(id -u)" -eq 0 ]; then
  chown -R ohmyomop-router:ohmyomop-router /app/data
  exec gosu ohmyomop-router "$@"
fi

exec "$@"
