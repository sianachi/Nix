#!/usr/bin/env bash
# Run on the Compose host from the release checkout. Never deletes volumes or seeds users.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
: "${NIX_DEPLOY_ENV:?absolute path to the private production env file}"
: "${NIXCTL_PROFILE:?authenticated nixctl profile for release verification}"
: "${NIX_SMOKE_WORKSPACE:?dedicated workspace for disposable smoke-test items}"
: "${NIX_BACKUP_REFERENCE:?absolute path to the backup directory made by deploy/compose/backup.sh}"
case "$NIX_BACKUP_REFERENCE" in /*) ;; *) echo 'NIX_BACKUP_REFERENCE must be an absolute backup directory path' >&2; exit 2;; esac
bash "$root/deploy/compose/backup.sh" --check "$NIX_BACKUP_REFERENCE"
case "$NIX_DEPLOY_ENV" in /*) ;; *) echo 'NIX_DEPLOY_ENV must be absolute' >&2; exit 2;; esac
compose=(docker compose -p nix --env-file "$NIX_DEPLOY_ENV" -f "$root/deploy/compose.prod.yml")
# Validate without printing interpolated credentials.
"${compose[@]}" config --quiet
release_config=$("${compose[@]}" --profile maintenance config --format json | python3 -c '
import json, sys
s = json.load(sys.stdin)["services"]
if not s["nix-collab-migrate"]["environment"].get("NIX_COLLAB_MIGRATOR_CONNECTION_STRING"):
    sys.exit("Set the separate collaboration migrator connection before deployment.")
registry, sep, tag = s["nix-api"]["image"].rpartition("/api:")
if not sep:
    sys.exit("Cannot derive the release-tools image from the nix-api image.")
print(s["nix-api"]["environment"]["Nix__Bff__PublicOrigin"])
print(registry + "/release-tools:" + tag)')
{ read -r NIX_SMOKE_ORIGIN; read -r release_tools_image; } <<< "$release_config"
export NIX_SMOKE_ORIGIN
# Smoke checks run from the release-tools image at the release tag; the host needs no Node.
nixctl_config=${NIXCTL_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/nixctl/config.json}
[ -f "$nixctl_config" ] || { echo "nixctl profile file not found: $nixctl_config" >&2; exit 2; }
case "$release_tools_image" in
  localhost/*) docker image inspect "$release_tools_image" >/dev/null ;;
  *) docker pull --quiet "$release_tools_image" >/dev/null ;;
esac
smoke() {
  docker run --rm --user "$(id -u):$(id -g)" -v "$nixctl_config:/config/nixctl/config.json:ro" \
    -e NIXCTL_PROFILE -e NIX_SMOKE_WORKSPACE -e NIX_SMOKE_ORIGIN "$release_tools_image" smoke "$@"
}
smoke --preflight
# Fetch release images before writers stop, so the maintenance window excludes the download.
# Host-built images (NIX_IMAGE_REGISTRY=localhost/nix) must already exist locally.
release_services=(nix-migrate nix-api nix-collab-migrate nix-collab nix-import-worker nix-export-worker nix-indexer nix-plugin-worker nix-web)
while IFS= read -r image; do
  case "$image" in
    localhost/*) docker image inspect "$image" >/dev/null ;;
    *) docker pull --quiet "$image" >/dev/null ;;
  esac
done < <("${compose[@]}" --profile maintenance config --images "${release_services[@]}" | sort -u)
# Preview drift before the first `up` can recreate anything; refuses infrastructure recreation.
bash "$root/deploy/compose/drift.sh" "${compose[@]}"
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
smoke
echo 'Compose release passed import/export verification. Complete browser checks in the runbook.'
