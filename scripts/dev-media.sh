#!/usr/bin/env bash
# Start the media service for local development.
#
# Simpler than dev-collab.sh, and the difference is the design rather than an
# omission: this service validates no tokens, so it needs no OIDC values and
# must not fail when deploy/.zitadel/oidc.generated.env is absent. It forwards
# the caller's token to the collaboration service, which authorizes it through
# Core - one authorization code path, in one place.
#
# It also holds no database credentials, ever, and refuses to start if any turn
# up in its environment. Do not add one here.
#
# Usage: scripts/dev-media.sh
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

export NIX_MEDIA_PORT="${NIX_MEDIA_PORT:-8200}"
export NIX_MEDIA_COLLAB_BASE_URL="${NIX_MEDIA_COLLAB_BASE_URL:-http://localhost:8100}"
# Must match NIX_COLLAB_INTERNAL_SECRET, which must match Nix.Api's
# Nix:InternalSecret user-secret. One value, three processes.
export NIX_MEDIA_INTERNAL_SECRET="${NIX_MEDIA_INTERNAL_SECRET:-nix-dev-internal}"

exec pnpm --filter @nix/media dev
