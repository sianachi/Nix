#!/usr/bin/env bash
# Rebuild the workspace packages when the checkout moved from <from> to <to> and packages/ changed.
# Run by the lefthook post-checkout, post-merge and post-rewrite hooks.
#
# Usage: scripts/rebuild-stale-packages.sh <from> <to>
set -euo pipefail

from=${1:?Usage: scripts/rebuild-stale-packages.sh <from> <to>}
to=${2:?Usage: scripts/rebuild-stale-packages.sh <from> <to>}

# A fresh clone checks out from the null commit; there is nothing stale yet.
git cat-file -e "$from^{commit}" 2>/dev/null || exit 0

if ! git diff --quiet "$from" "$to" -- pnpm-lock.yaml; then
  echo 'rebuild-stale-packages: pnpm-lock.yaml changed; run pnpm install (it rebuilds the packages too).'
elif ! git diff --quiet "$from" "$to" -- packages; then
  echo 'rebuild-stale-packages: packages/ changed; rebuilding the workspace packages.'
  pnpm run prepare
fi
