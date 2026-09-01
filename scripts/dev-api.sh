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
export Nix__RabbitMq__Uri="${Nix__RabbitMq__Uri:-${NIX_RABBITMQ_API_URL:-amqp://nix-api:nix-dev-api-rabbit@localhost:5673/%2Fnix}}"
export Nix__ObjectStorage__Endpoint="${Nix__ObjectStorage__Endpoint:-http://localhost:${VERSITY_PORT:-7070}}"
export Nix__ObjectStorage__Region="${Nix__ObjectStorage__Region:-us-east-1}"
export Nix__ObjectStorage__Bucket="${Nix__ObjectStorage__Bucket:-nix-worker-jobs}"
export Nix__ObjectStorage__AccessKey="${Nix__ObjectStorage__AccessKey:-${VERSITY_ROOT_ACCESS_KEY:-nix-dev-access}}"
export Nix__ObjectStorage__SecretKey="${Nix__ObjectStorage__SecretKey:-${VERSITY_ROOT_SECRET_KEY:-nix-dev-secret-key}}"
export Nix__Search__OpenSearchEnabled="${Nix__Search__OpenSearchEnabled:-false}"
export Nix__Search__OpenSearchUrl="${Nix__Search__OpenSearchUrl:-http://localhost:${NIX_OPENSEARCH_PORT:-9201}}"
export Nix__Search__OpenSearchIndex="${Nix__Search__OpenSearchIndex:-nix-items}"
export Nix__Collaboration__BaseUrl="${Nix__Collaboration__BaseUrl:-http://localhost:8100}"
export Nix__Bff__Authority="$NIX_OIDC_ISSUER"
export Nix__Bff__ClientId="$NIX_OIDC_CLIENT_ID"
export Nix__Bff__PublicOrigin="http://localhost:5173"
export Nix__Bff__DataProtectionKeysPath="$repo_root/deploy/.dev-data-protection"
export Nix__AccessTokens__Issuer="http://localhost:5014"
export Nix__AccessTokens__Audience="nix"
export Nix__AccessTokens__KeyId="nix-dev-access-tokens"
export Nix__AccessTokens__SigningKeyPemFile="$repo_root/$signing_key"

exec dotnet run --project backend/src/Nix.Api --launch-profile http
