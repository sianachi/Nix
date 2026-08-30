#!/usr/bin/env bash
# Start the collaboration service for local development, wired to whatever
# Zitadel client/project id this machine's dev stack currently has.
#
# The collab service needs NIX_COLLAB_OIDC_AUDIENCE built from two values
# (NIX_OIDC_CLIENT_ID and NIX_OIDC_PROJECT_ID) that zitadel-configure.sh
# writes under different names - a plain npm run configuration can't do that
# remap on its own, so this script does it and then hands off to the
# package's own dev script.
#
# Usage: scripts/dev-collab.sh
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

oidc_env="deploy/.zitadel/oidc.generated.env"
if [ ! -f "$oidc_env" ]; then
  echo "dev-collab: $oidc_env not found - run scripts/dev-stack-up.sh first" >&2
  exit 1
fi
# shellcheck disable=SC1090
. "$oidc_env"

export NIX_COLLAB_DATABASE_URL="${NIX_COLLAB_DATABASE_URL:-postgresql://nix_collab:nix-dev-collab@localhost:5433/nix}"
export NIX_COLLAB_CORE_BASE_URL="${NIX_COLLAB_CORE_BASE_URL:-http://localhost:5014}"
# Must match Nix.Api's Nix:InternalSecret user-secret (see README's Debugging section).
export NIX_COLLAB_INTERNAL_SECRET="${NIX_COLLAB_INTERNAL_SECRET:-nix-dev-internal}"
export NIX_COLLAB_OIDC_ISSUERS="$NIX_OIDC_ISSUER,http://localhost:5014|http://localhost:5014/public/v1/auth/jwks"
export NIX_COLLAB_OIDC_AUDIENCE="$NIX_OIDC_CLIENT_ID,$NIX_OIDC_PROJECT_ID,nix"

exec pnpm --filter @nix/collab dev
