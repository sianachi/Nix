#!/usr/bin/env bash
# Entrypoint for the release-tools image: `smoke [--preflight]` or `nixctl <args>`.
set -euo pipefail
usage() {
  cat <<'USAGE'
Usage: release-tools smoke [--preflight]
       release-tools nixctl <args>

smoke     Run the Compose release smoke checks through nixctl. --preflight checks only
          authentication and the smoke workspace. Requires NIXCTL_PROFILE,
          NIX_SMOKE_WORKSPACE and NIX_SMOKE_ORIGIN.
nixctl    Run the Nix CLI.

Mount the nixctl profile file read-only at /config/nixctl/config.json.
USAGE
}
command=${1:---help}
[ "$#" -gt 0 ] && shift
case "$command" in
  smoke)
    case "${1:-}" in -h|--help) usage; exit 0;; esac
    exec node /repo/deploy/compose/smoke.mjs "$@"
    ;;
  nixctl) exec /repo/deploy/compose/nixctl.sh "$@" ;;
  -h|--help|help) usage ;;
  *) usage >&2; exit 2 ;;
esac
