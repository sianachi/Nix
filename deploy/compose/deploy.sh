#!/usr/bin/env bash
# Run on the Compose host from the release checkout. Never deletes volumes or seeds users.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
: "${NIX_DEPLOY_ENV:?absolute path to the private production env file}"
: "${NIXCTL_PROFILE:?authenticated nixctl profile for release verification}"
: "${NIX_SMOKE_WORKSPACE:?dedicated workspace for disposable smoke-test items}"
: "${NIX_BACKUP_REFERENCE:?record the verified database and object-store backup reference}"
case "$NIX_DEPLOY_ENV" in /*) ;; *) echo 'NIX_DEPLOY_ENV must be absolute' >&2; exit 2;; esac
compose=(docker compose -p nix --env-file "$NIX_DEPLOY_ENV" -f "$root/deploy/compose.prod.yml")
# Validate without printing interpolated credentials.
"${compose[@]}" config --quiet
NIX_SMOKE_ORIGIN=$("${compose[@]}" --profile maintenance config --format json | node -e '
let s=""; process.stdin.on("data", d=>s+=d); process.stdin.on("end",()=>{
 const c=JSON.parse(s);
 if (!c.services["nix-collab-migrate"].environment.NIX_COLLAB_MIGRATOR_CONNECTION_STRING) {
  console.error("Set the separate collaboration migrator connection before deployment."); process.exit(1);
 }
 console.log(c.services["nix-api"].environment.Nix__Bff__PublicOrigin);
});')
export NIX_SMOKE_ORIGIN
node "$root/deploy/compose/smoke.mjs" --preflight
while IFS= read -r image; do
  case "$image" in localhost/nix/*) docker image inspect "$image" >/dev/null ;; esac
done < <("${compose[@]}" config --images)
"${compose[@]}" up -d --wait --wait-timeout 180 postgres rabbitmq nix-opensearch nix-versitygw
"${compose[@]}" --profile maintenance run --rm --no-deps nix-storage-init
# Stop writers while document/schema migrations run. Failure leaves them stopped for inspection.
"${compose[@]}" stop nix-web nix-import-worker nix-export-worker nix-indexer nix-plugin-worker nix-collab nix-api
"${compose[@]}" run --rm --no-deps nix-migrate
"${compose[@]}" run --rm --no-deps nix-template-presets
"${compose[@]}" run --rm --no-deps nix-api-init
"${compose[@]}" --profile maintenance run --rm --no-deps nix-collab-migrate
"${compose[@]}" up -d --no-deps --wait --wait-timeout 180 nix-api nix-collab
"${compose[@]}" up -d --no-deps --wait --wait-timeout 180 nix-import-worker nix-export-worker nix-indexer nix-plugin-worker nix-web cloudflared
node "$root/deploy/compose/smoke.mjs"
echo 'Compose release passed import/export verification. Complete browser checks in the runbook.'
