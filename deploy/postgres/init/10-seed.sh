#!/usr/bin/env bash
# Postgres first-boot hook.
#
# The official image runs everything in /docker-entrypoint-initdb.d once, when
# it initialises an empty data volume. This applies the same seed files that
# deploy/seed/seed.sh applies on demand, so a fresh `up` needs no extra step
# and a later manual run is still a no-op.
#
# Runs inside the container, where the entrypoint has already started a local
# Postgres and exported the superuser credentials.
set -euo pipefail

db_name="${NIX_PG_DB:-nix}"
app_password="${NIX_PG_APP_PASSWORD:-nix-dev-app}"
migrator_password="${NIX_PG_MIGRATOR_PASSWORD:-nix-dev-migrator}"

echo "nix-init: applying roles"
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres \
  -v app_password="$app_password" \
  -v migrator_password="$migrator_password" \
  -v db_name="$db_name" \
  -f /nix-seed/seed.sql

if [ "$(psql -tAc "SELECT 1 FROM pg_database WHERE datname = '$db_name'" \
        -U "$POSTGRES_USER" -d postgres)" = "1" ]; then
  echo "nix-init: database '$db_name' already present"
else
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres \
    -c "CREATE DATABASE \"$db_name\" OWNER nix_migrator"
  echo "nix-init: created database '$db_name'"
fi

echo "nix-init: applying database configuration"
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$db_name" \
  -v db_name="$db_name" \
  -f /nix-seed/seed_database.sql

echo "nix-init: complete"
