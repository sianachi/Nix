#!/usr/bin/env bash
# Starts Core with the local Zitadel client, BFF session policy and Core signing key.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

oidc_env="deploy/.zitadel/oidc.generated.env"
if [ ! -f "$oidc_env" ]; then
  echo "dev-api: $oidc_env not found - run scripts/dev-stack-up.sh first" >&2
  exit 1
fi
# shellcheck disable=SC1090
. "$oidc_env"

signing_key="deploy/.dev-access-token-key.pem"
if [ ! -f "$signing_key" ]; then
  openssl ecparam -name prime256v1 -genkey -noout -out "$signing_key"
  chmod 600 "$signing_key"
fi
mkdir -p deploy/.dev-data-protection

export ConnectionStrings__Nix="${ConnectionStrings__Nix:-Host=localhost;Port=5433;Database=nix;Username=nix_app;Password=nix-dev-app}"
export Nix__InternalSecret="${Nix__InternalSecret:-nix-dev-internal}"
export Nix__RabbitMq__Uri="${Nix__RabbitMq__Uri:-amqp://nix:nix-dev-rabbit@localhost:5673/nix}"
export Nix__Bff__Authority="$NIX_OIDC_ISSUER"
export Nix__Bff__ClientId="$NIX_OIDC_CLIENT_ID"
export Nix__Bff__PublicOrigin="http://localhost:5173"
export Nix__Bff__DataProtectionKeysPath="$repo_root/deploy/.dev-data-protection"
export Nix__AccessTokens__Issuer="http://localhost:5014"
export Nix__AccessTokens__Audience="nix"
export Nix__AccessTokens__KeyId="nix-dev-access-tokens"
export Nix__AccessTokens__SigningKeyPemFile="$repo_root/$signing_key"

exec dotnet run --project backend/src/Nix.Api --launch-profile http
