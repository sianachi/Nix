#!/usr/bin/env bash
# Apply pending EF Core migrations against the local dev database.
#
# The one-shot step from docs/dev-signing-in.md's cold-start sequence, as a
# reusable script rather than a copy-pasted export-and-run line. EF Core
# migrations no-op on an up-to-date schema, so this is safe to re-run.
#
# Usage: scripts/dev-migrate.sh
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"

NIX_MIGRATOR_CONNECTION_STRING="Host=localhost;Port=5433;Database=nix;Username=nix_migrator;Password=nix-dev-migrator" \
  dotnet run --project "$repo_root/backend/src/Nix.Migrator"
