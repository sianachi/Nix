#!/usr/bin/env bash
# Exercises `backup.sh --check` against fixture directories; needs no Docker.
#   backup.test.sh                 run the checks
#   backup.test.sh --fixture DIR   only write a valid fixture backup to DIR (used by check.test.sh)
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
backup=$root/deploy/compose/backup.sh

make_fixture() {
  local dir=$1 name
  mkdir -m 700 "$dir"
  for name in nix.dump roles.sql nix-versity-data.tar nix-api-data-protection.tar nix-companion-data.tar \
    env.private core-access-token.pem compose.prod.yml Caddyfile.prod containers.private.json; do
    printf 'fixture %s\n' "$name" > "$dir/$name"
  done
  (cd "$dir" && sha256sum -- * > SHA256SUMS)
  {
    echo 'result=passed'
    echo 'verified_at=2026-01-01T00:00:00Z'
    echo 'release=fixture'
    echo "sha256sums=$(sha256sum < "$dir/SHA256SUMS" | cut -d' ' -f1)"
  } > "$dir/verified.txt"
  chmod 600 "$dir"/*
}

if [[ ${1:-} == --fixture ]]; then
  [[ $# -eq 2 ]] || { echo 'usage: backup.test.sh --fixture DIR' >&2; exit 2; }
  make_fixture "$2"
  exit 0
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
chmod 700 "$work"

expect_fail() {
  local label=$1 pattern=$2 dir=$3
  if bash "$backup" --check "$dir" > "$work/out" 2>&1; then
    echo "backup --check accepted: $label" >&2; exit 1
  fi
  grep -q -- "$pattern" "$work/out" || { echo "unclear rejection for $label:" >&2; cat "$work/out" >&2; exit 1; }
}

make_fixture "$work/valid"
bash "$backup" --check "$work/valid" > "$work/out"
grep -q 'backup verified' "$work/out"

make_fixture "$work/bad-checksum"
printf 'tampered\n' >> "$work/bad-checksum/nix.dump"
expect_fail 'bad checksum' 'SHA256SUMS verification failed' "$work/bad-checksum"

make_fixture "$work/no-verified"
rm "$work/no-verified/verified.txt"
expect_fail 'missing verified.txt' 'missing verified.txt' "$work/no-verified"

make_fixture "$work/failed-restore"
sed -i.orig 's/^result=passed$/result=failed/' "$work/failed-restore/verified.txt"
rm "$work/failed-restore/verified.txt.orig"
expect_fail 'failed restore' 'passed restore' "$work/failed-restore"

make_fixture "$work/missing-dump"
rm "$work/missing-dump/nix.dump"
expect_fail 'missing dump' 'missing nix.dump' "$work/missing-dump"

make_fixture "$work/uncovered"
grep -v ' roles.sql$' "$work/uncovered/SHA256SUMS" > "$work/sums" && cat "$work/sums" > "$work/uncovered/SHA256SUMS"
expect_fail 'file missing from SHA256SUMS' 'does not cover roles.sql' "$work/uncovered"

make_fixture "$work/readable"
chmod 644 "$work/readable/env.private"
expect_fail 'group-readable secret' 'readable by group or others' "$work/readable"

expect_fail 'relative path' 'absolute path' valid
expect_fail 'absent directory' 'does not exist' "$work/absent"

if bash "$backup" > "$work/out" 2>&1; then echo 'backup.sh ran without arguments' >&2; exit 1; fi
if NIX_BACKUP_ROOT="$work" NIX_DEPLOY_ENV="$work/valid/env.private" bash "$backup" '../escape' > "$work/out" 2>&1; then
  echo 'backup.sh accepted a path-like release sha' >&2; exit 1
fi
echo 'Backup check passed for a valid fixture and rejected damaged ones.'
