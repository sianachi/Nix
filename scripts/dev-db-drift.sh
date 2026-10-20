#!/usr/bin/env bash
# Compare the dev database schema (owners and grants included) with a scratch database built from
# this checkout's migrations. Any difference is drift: a hand-applied grant or an old function body
# in dev can hide a migration that is missing. A dev database last migrated from another branch
# shows that branch's migrations as drift too.
#
# Usage: scripts/dev-db-drift.sh   (needs the core profile up; exits 1 when the schemas differ)
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

dev_db="${NIX_PG_DB:-nix}"
scratch_db=nix_drift_check
log=$(mktemp "${TMPDIR:-/tmp}/nix-db-drift.XXXXXX")

psql_super() {
  docker compose -f deploy/compose.dev.yml --profile core exec -T \
    -e PGPASSWORD="${NIX_PG_SUPERUSER_PASSWORD:-nix-dev-superuser}" postgres "$@"
}

drop_scratch() {
  psql_super psql -q -U postgres -d postgres -c "DROP DATABASE IF EXISTS $scratch_db WITH (FORCE)" >/dev/null
  rm -f "$log"
}

# pg_dump writes a random \restrict key per dump; drop it so equal schemas diff clean.
schema_of() {
  psql_super pg_dump -U postgres --schema-only "$1" | grep -vE '^\\(un)?restrict '
}

drop_scratch
trap drop_scratch EXIT

echo "dev-db-drift: building $scratch_db from migrations"
if ! { NIX_PG_DB=$scratch_db deploy/seed/seed.sh && NIX_PG_DB=$scratch_db scripts/dev-migrate.sh; } >"$log" 2>&1; then
  cat "$log" >&2
  echo 'dev-db-drift: could not build the scratch database' >&2
  exit 2
fi

if diff -u --label "$dev_db (dev)" --label "$scratch_db (migrations)" \
    <(schema_of "$dev_db") <(schema_of "$scratch_db"); then
  echo "dev-db-drift: $dev_db matches the migrations."
else
  echo "dev-db-drift: $dev_db differs from the migrations (lines with - exist only in dev)." >&2
  exit 1
fi
