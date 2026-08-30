#!/usr/bin/env bash
# Bring up the whole local dev stack: infra, schema, Zitadel, seed data.
#
# The cold-start sequence docs/dev-signing-in.md documents as seven separate
# commands, as one. Every step here is independently idempotent (seed.sh and
# zitadel-configure.sh say so in their own header comments; EF Core migrations
# no-op on an up-to-date schema; `docker compose up -d` no-ops on running
# containers), so this is safe to run before every "Full Stack" launch, not
# only on a cold machine.
#
# Usage: scripts/dev-stack-up.sh
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

docker compose -f deploy/compose.dev.yml --profile core up -d
deploy/seed/seed.sh
scripts/dev-migrate.sh
deploy/seed/zitadel-configure.sh
deploy/seed/seed.sh   # second pass: the schema exists now, seeds tenants + identity_provider

echo "dev-stack-up: start Core with scripts/dev-api.sh and web with pnpm --filter @nix/web dev"
