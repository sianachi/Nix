#!/usr/bin/env bash
# Execute the deterministic commands selected by changed-path-checks.sh.
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
planner="$script_dir/changed-path-checks.sh"
dry_run=false

if [ "${1:-}" = '--dry-run' ]; then
  dry_run=true
  shift
fi

if [ "${1:-}" = '--help' ] || [ "${1:-}" = '-h' ]; then
  cat <<'EOF'
Usage: scripts/validate-changed.sh [--dry-run] [--working-tree | --base <ref> | <path>...]

Uses changed-path-checks.sh to select checks. Runs each selected command in
order, stopping at the first failure. --dry-run prints the exact command list.
EOF
  exit 0
fi

commands_file=$(mktemp "${TMPDIR:-/tmp}/nix-validate-changed.XXXXXX")
trap 'rm -f "$commands_file"' EXIT
"$planner" --commands "$@" > "$commands_file"

if [ ! -s "$commands_file" ]; then
  echo 'validate-changed: no checks selected.'
  exit 0
fi

if [ "$dry_run" = true ]; then
  cat "$commands_file"
  exit 0
fi

while IFS= read -r command; do
  [ -n "$command" ] || continue
  printf '\n[validate-changed] %s\n' "$command"
  bash -c "$command"
done < "$commands_file"

echo
echo 'validate-changed: all selected checks passed.'
