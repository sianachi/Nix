#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
compose_file="$repo_root/deploy/compose.dev.yml"
db_name="${NIX_PG_DB:-nix}"

docker compose -f "$compose_file" --profile core exec -T \
  -e PGPASSWORD="${NIX_PG_SUPERUSER_PASSWORD:-nix-dev-superuser}" \
  postgres psql -v ON_ERROR_STOP=1 -U postgres -d "$db_name" \
  < "$repo_root/scripts/stress/mvp1-seed.sql"
