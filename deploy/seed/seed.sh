#!/usr/bin/env bash
# Seed the Nix development database.
#
# Idempotent: safe to run any number of times. Waits for Postgres to report
# healthy, creates the application database if absent, then applies the
# cluster-level seed (roles) and the per-database seed (extensions, grants).
#
# Usage (from anywhere):
#   deploy/seed/seed.sh
#
# Requires the core profile to be up:
#   docker compose -f deploy/compose.dev.yml --profile core up -d
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
compose_file="$(cd "$script_dir/.." && pwd)/compose.dev.yml"

db_name="${NIX_PG_DB:-nix}"
app_password="${NIX_PG_APP_PASSWORD:-nix-dev-app}"
migrator_password="${NIX_PG_MIGRATOR_PASSWORD:-nix-dev-migrator}"

compose() {
  docker compose -f "$compose_file" --profile core "$@"
}

# psql inside the postgres container, as superuser, failing on first error.
psql_super() {
  compose exec -T -e PGPASSWORD="${NIX_PG_SUPERUSER_PASSWORD:-nix-dev-superuser}" \
    postgres psql -v ON_ERROR_STOP=1 -U postgres "$@"
}

echo "seed: waiting for postgres to become healthy"
deadline=$((SECONDS + 120))
until compose exec -T postgres pg_isready -U postgres -d postgres >/dev/null 2>&1; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "seed: postgres did not become ready within 120s" >&2
    echo "seed: is the core profile up? docker compose -f $compose_file --profile core up -d" >&2
    exit 1
  fi
  sleep 2
done
echo "seed: postgres is ready"

# ── Roles (cluster level) ───────────────────────────────────────────────────
echo "seed: applying roles"
psql_super -d postgres \
  -v app_password="$app_password" \
  -v migrator_password="$migrator_password" \
  -v db_name="$db_name" \
  -f /nix-seed/seed.sql

# ── Database ────────────────────────────────────────────────────────────────
# CREATE DATABASE cannot run inside a DO block or a transaction, so existence
# is checked first and creation is a separate statement.
if [ "$(psql_super -d postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname = '$db_name'")" = "1" ]; then
  echo "seed: database '$db_name' already present"
else
  psql_super -d postgres -c "CREATE DATABASE \"$db_name\" OWNER nix_migrator"
  echo "seed: created database '$db_name'"
fi

# ── Extensions and grants (inside the database) ─────────────────────────────
echo "seed: applying database configuration"
psql_super -d "$db_name" -v db_name="$db_name" -f /nix-seed/seed_database.sql

echo
echo "seed: complete."
echo "  database : $db_name on localhost:${NIX_PG_PORT:-5433}"
echo "  roles    : nix_migrator (BYPASSRLS, owns schema), nix_app (NOBYPASSRLS)"
echo "  app DSN  : Host=localhost;Port=${NIX_PG_PORT:-5433};Database=$db_name;Username=nix_app;Password=$app_password"
echo "seed: re-running this script is a no-op."
