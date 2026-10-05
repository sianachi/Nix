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
release_services=(nix-migrate nix-api nix-collab-migrate nix-collab nix-import-worker nix-export-worker nix-indexer nix-plugin-worker nix-calendar-worker nix-notify-worker nix-web)
# The speech role is optional (the `speech` Compose profile). Where it is deployed its image is
# fetched with the others, it is stopped with the other writers, and it is started again only
# after the release has been verified.
speech=()
if "${compose[@]}" config --services | grep -qx nix-speech-worker; then
  speech=(nix-speech-worker)
  release_services+=(nix-speech-worker)
  # The profile is on, so the broker account must exist: without a password the account is
  # deleted and the worker would loop on a refused login, told only as "did not become healthy".
  if "${compose[@]}" config --format json | python3 -c '
import json, sys
url = json.load(sys.stdin)["services"]["nix-speech-worker"]["environment"].get("NIX_RABBITMQ_URL", "")
sys.exit(0 if ":unset@" in url else 1)'; then
    echo 'The speech profile is on but NIX_RABBITMQ_SPEECH_PASSWORD (or NIX_RABBITMQ_SPEECH_URL) is not set.' >&2
    exit 2
  fi
fi
while IFS= read -r image; do
  case "$image" in
    localhost/*) docker image inspect "$image" >/dev/null ;;
    *) docker pull --quiet "$image" >/dev/null ;;
  esac
done < <("${compose[@]}" --profile maintenance config --images "${release_services[@]}" | sort -u)
# Check the release's bind mounts as RabbitMQ's runtime user before stopping writers.
# A private umask on the checkout can leave these public source files unreadable.
"${compose[@]}" run --rm --no-deps --entrypoint /bin/sh rabbitmq -c 'for file in /usr/local/bin/nix-rabbitmq-start /etc/rabbitmq/rabbitmq.conf /etc/rabbitmq/definitions.json; do if [ ! -r "$file" ]; then printf "Release bind mount is not readable: %s\n" "$file" >&2; exit 1; fi; done'
# Preview drift before anything is recreated; refuses recreating stateful infrastructure.
bash "$root/deploy/compose/drift.sh" "${compose[@]}"
# Stop writers before the infrastructure `up`, and keep them stopped while document/schema
# migrations run. RabbitMQ mounts its configuration from the release checkout, so every release
# recreates it; with publishers and consumers stopped, that restart cannot interrupt a delivery
# (queues are durable and messages persistent). Failure leaves writers stopped for inspection.
"${compose[@]}" stop nix-web nix-import-worker nix-export-worker nix-indexer nix-plugin-worker nix-calendar-worker nix-notify-worker nix-collab nix-api ${speech[@]+"${speech[@]}"}
"${compose[@]}" up -d --wait --wait-timeout 180 postgres rabbitmq nix-opensearch nix-versitygw
"${compose[@]}" --profile maintenance run --rm --no-deps nix-storage-init
"${compose[@]}" run --rm --no-deps nix-migrate
"${compose[@]}" run --rm --no-deps nix-template-presets
"${compose[@]}" run --rm --no-deps nix-api-init
"${compose[@]}" --profile maintenance run --rm --no-deps nix-collab-migrate
"${compose[@]}" up -d --no-deps --wait --wait-timeout 180 nix-api nix-collab
"${compose[@]}" up -d --no-deps --wait --wait-timeout 180 nix-import-worker nix-export-worker nix-indexer nix-plugin-worker nix-calendar-worker nix-notify-worker nix-web cloudflared
smoke
# After the smoke check, and not fatal: recordings wait in their queue and the browser falls back
# to its own voices, so a speech worker that does not come up must not fail a verified release.
if [ "${#speech[@]}" -gt 0 ]; then
  "${compose[@]}" up -d --no-deps --wait --wait-timeout 300 "${speech[@]}" \
    || echo 'The speech worker did not become healthy. The release stands; see the speech section of deploy/README.md.' >&2
fi
echo 'Compose release passed import/export verification. Complete browser checks in the runbook.'
