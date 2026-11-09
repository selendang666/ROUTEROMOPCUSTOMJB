#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")"
: "${UPSTREAM_BASE:?Set UPSTREAM_BASE, including /v1 when the upstream exposes it}"
: "${UPSTREAM_API_KEY:?Set UPSTREAM_API_KEY}"
relay_count=23
vercel_package="${VERCEL_CLI_PACKAGE:-vercel@59.26.0}"
if command -v vercel >/dev/null 2>&1; then
  vercel_command=(vercel)
elif command -v npx >/dev/null 2>&1; then
  vercel_command=(npx --yes "$vercel_package")
else
  printf 'Install the Vercel CLI or npx before deployment.\n' >&2
  exit 1
fi
vercel_cli() {
  "${vercel_command[@]}" "$@"
}
if ! vercel_cli whoami >/dev/null; then
  printf 'Vercel authentication failed. Set VERCEL_TOKEN or run vercel login.\n' >&2
  exit 1
fi
if [ -f relays.json ]; then
  node -e 'const fs=require("node:fs");const raw=JSON.parse(fs.readFileSync("relays.json","utf8"));if(!Array.isArray(raw.relays)||raw.relays.length!==23)throw new Error("relays.json must contain exactly 23 relays")'
else
  node -e 'const fs=require("node:fs");fs.writeFileSync("relays.json",`${JSON.stringify({relays:Array(23).fill(null)},null,2)}\n`,{mode:0o600})'
fi
workdir=$(mktemp -d "${TMPDIR:-/tmp}/ohmyomop-router-relays.XXXXXX")
trap 'rm -rf "$workdir"' EXIT
scope_args=()
if [ -n "${VERCEL_SCOPE:-}" ]; then
  scope_args=(--scope "$VERCEL_SCOPE")
fi
for index in $(seq 0 22); do
  number=$(printf '%02d' "$((index + 1))")
  directory="$workdir/relay-$number"
  deploy_log="$workdir/relay-$number.deploy.log"
  secret=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
  cp -r relay "$directory"
  mkdir -p "$directory/api"
  cp "$directory/index.js" "$directory/api/proxy.js"
  (
    cd "$directory"
    vercel_cli link --yes --project "montana-relay-$number" "${scope_args[@]}"
    printf '%s' "$UPSTREAM_BASE" | vercel_cli env add UPSTREAM_BASE production --sensitive --yes
    printf '%s' "$UPSTREAM_API_KEY" | vercel_cli env add UPSTREAM_API_KEY production --sensitive --yes
    printf '%s' "$secret" | vercel_cli env add RELAY_SECRET production --sensitive --yes
    printf '%s' "relay-$number" | vercel_cli env add RELAY_ID production --no-sensitive --yes
    vercel_cli deploy --prod --yes
  ) | tee "$deploy_log"
  deployment_url=$(node - "$deploy_log" <<'NODE'
const fs = require("node:fs");
const text = fs.readFileSync(process.argv[2], "utf8");
const matches = [...text.matchAll(/https:\/\/[^\s]+\.vercel\.app/gi)].map((match) => match[0].replace(/[),.]+$/, ""));
if (matches.length === 0) throw new Error("Vercel deployment URL was not found in CLI output");
console.log(matches.at(-1));
NODE
  )
  relay_url="$deployment_url/api/proxy"
  RELAY_INDEX="$index" RELAY_URL="$relay_url" RELAY_SECRET_VALUE="$secret" node <<'NODE'
const fs = require("node:fs");
const file = "relays.json";
const data = JSON.parse(fs.readFileSync(file, "utf8"));
data.relays[Number(process.env.RELAY_INDEX)] = { url: process.env.RELAY_URL, secret: process.env.RELAY_SECRET_VALUE };
const temporary = `${file}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temporary, file);
NODE
  printf 'Configured relay-%s at %s\n' "$number" "$relay_url"
done
printf 'Deployed 23 relays and updated relays.json with their unique relay secrets.\n'
