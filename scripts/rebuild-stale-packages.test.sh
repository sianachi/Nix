#!/usr/bin/env bash
# Self-test for rebuild-stale-packages.sh against a scratch repository and a stub pnpm.
set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/rebuild-stale-packages.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/bin" "$work/repo/packages/a"
printf '#!/bin/sh\necho "pnpm $*"\n' > "$work/bin/pnpm"
chmod +x "$work/bin/pnpm"
export PATH="$work/bin:$PATH"

cd "$work/repo"
git init -q
git -c user.name=t -c user.email=t@t commit -q --allow-empty -m base
echo 1 > README.md && git add . && git -c user.name=t -c user.email=t@t commit -q -m docs
echo 1 > packages/a/index.ts && git add . && git -c user.name=t -c user.email=t@t commit -q -m pkg
echo 1 > pnpm-lock.yaml && git add . && git -c user.name=t -c user.email=t@t commit -q -m lock

fail() { echo "FAIL: $1" >&2; exit 1; }

[ -z "$("$script" HEAD~3 HEAD~2)" ] || fail 'docs-only change should do nothing'
"$script" HEAD~2 HEAD~1 | grep -q 'pnpm run prepare' || fail 'packages/ change should rebuild'
out=$("$script" HEAD~1 HEAD)
echo "$out" | grep -q 'run pnpm install' || fail 'lockfile change should ask for pnpm install'
echo "$out" | grep -q 'pnpm run prepare' && fail 'lockfile change should not also rebuild'
[ -z "$("$script" 0000000000000000000000000000000000000000 HEAD)" ] || fail 'null commit should do nothing'

echo 'rebuild-stale-packages: all tests passed.'
