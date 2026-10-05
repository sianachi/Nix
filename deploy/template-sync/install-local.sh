#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
pnpm --filter @nix/template-catalog build

export NIX_TEMPLATE_BOOT_BUILTIN_DIRECTORY="${NIX_TEMPLATE_BOOT_BUILTIN_DIRECTORY:-$repo_root/packages/template-catalog/templates}"
export NIX_TEMPLATE_BOOT_DIRECTORY="${NIX_TEMPLATE_BOOT_DIRECTORY:-$repo_root/deploy/templates/operator}"
mkdir -p "$NIX_TEMPLATE_BOOT_DIRECTORY"
exec node deploy/template-sync/sync-managed-templates.mjs
