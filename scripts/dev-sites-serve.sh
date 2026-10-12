#!/usr/bin/env bash
# Starts the anonymous sites server (apps/sites) for local development. A site is reachable at
# http://<slug>.sites.localhost:8400 (curl, Chrome and Firefox resolve *.localhost; if yours does
# not, use `curl --resolve <slug>.sites.localhost:8400:127.0.0.1`).
#
# Locally it reads the bucket with the object store's root keys. Production must use a read-only
# key scoped to the sites bucket.
#
# Usage: scripts/dev-sites-serve.sh
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

export NIX_SITES_SERVE_ADDRESS="${NIX_SITES_SERVE_ADDRESS:-:8400}"
export NIX_SITES_S3_ENDPOINT="${NIX_SITES_S3_ENDPOINT:-http://localhost:${VERSITY_PORT:-7070}}"
export NIX_SITES_S3_REGION="${NIX_SITES_S3_REGION:-us-east-1}"
export NIX_SITES_S3_BUCKET="${NIX_SITES_S3_BUCKET:-nix-sites}"
export NIX_SITES_S3_ACCESS_KEY="${NIX_SITES_S3_ACCESS_KEY:-${VERSITY_ROOT_ACCESS_KEY:-nix-dev-access}}"
export NIX_SITES_S3_SECRET_KEY="${NIX_SITES_S3_SECRET_KEY:-${VERSITY_ROOT_SECRET_KEY:-nix-dev-secret-key}}"
export NIX_SITES_ALLOWED_SUFFIX="${NIX_SITES_ALLOWED_SUFFIX:-sites.localhost}"

exec pnpm --filter @nix/sites dev:serve
