#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
runner="$script_dir/validate-changed.sh"

output=$("$runner" --dry-run apps/web/src/app.tsx)
case "$output" in
  *'pnpm --filter @nix/web typecheck'*) ;;
  *) echo 'validate-changed dry run omitted the web typecheck.' >&2; exit 1 ;;
esac

echo 'validate-changed.test: passed'
