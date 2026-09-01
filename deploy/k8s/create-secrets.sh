#!/usr/bin/env bash
# One-time setup: generates the secrets a Nix deployment needs and the derived
# connection strings, then loads deploy/seed's cluster-level SQL as a ConfigMap.
#
# Do NOT reuse the values in .env.example - that file is committed on purpose and every
# value in it is public. Run this once per cluster; re-running after nix-db already exists
# refuses rather than silently rotating passwords the seeded database roles don't know about
# yet (use deploy/k8s/job-seed.yaml to rotate instead - see section 9 of
# docs/nix-k3s-deployment.md).
#
# This puts passwords through the shell and into `kubectl create secret`, which is what ends
# up in your shell history. Consider sealed-secrets or an external-secrets operator instead
# once this is more than a first bring-up.
#
# Existing clusters can rotate only the RabbitMQ identities without touching database or signing
# secrets by running: deploy/k8s/create-secrets.sh --rabbitmq-only
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

kubectl get namespace nix >/dev/null 2>&1 || kubectl apply -f deploy/k8s/namespace.yaml

create_rabbitmq_secret() {
  local update_existing="$1"
  local rabbitmq_api_password rabbitmq_import_password rabbitmq_export_password rabbitmq_index_password
  local rabbitmq_api_url rabbitmq_import_url rabbitmq_export_url rabbitmq_index_url rabbitmq_url

  rabbitmq_api_password="$(openssl rand -hex 24)"
  rabbitmq_import_password="$(openssl rand -hex 24)"
  rabbitmq_export_password="$(openssl rand -hex 24)"
  rabbitmq_index_password="$(openssl rand -hex 24)"

  # The defaults are intentionally plaintext only across the namespace-internal NetworkPolicy.
  # Supplying all four full amqps:// URLs moves application traffic to an external TLS broker while
  # retaining independent identities. Port 443 is already permitted by the worker egress policy.
  rabbitmq_api_url="${NIX_RABBITMQ_API_URL:-amqp://nix-api:$rabbitmq_api_password@nix-rabbitmq:5672/%2Fnix}"
  rabbitmq_import_url="${NIX_RABBITMQ_IMPORT_URL:-amqp://nix-import:$rabbitmq_import_password@nix-rabbitmq:5672/%2Fnix}"
  rabbitmq_export_url="${NIX_RABBITMQ_EXPORT_URL:-amqp://nix-export:$rabbitmq_export_password@nix-rabbitmq:5672/%2Fnix}"
  rabbitmq_index_url="${NIX_RABBITMQ_INDEX_URL:-amqp://nix-index:$rabbitmq_index_password@nix-rabbitmq:5672/%2Fnix}"
  for rabbitmq_url in "$rabbitmq_api_url" "$rabbitmq_import_url" "$rabbitmq_export_url" "$rabbitmq_index_url"; do
    case "$rabbitmq_url" in
      amqp://* | amqps://*) ;;
      *)
        echo "RabbitMQ URLs must use amqp:// or amqps://." >&2
        exit 1
        ;;
    esac
  done

  local -a rabbitmq_secret_args=(
    -n nix create secret generic nix-rabbitmq
    --from-literal=api-password="$rabbitmq_api_password"
    --from-literal=import-password="$rabbitmq_import_password"
    --from-literal=export-password="$rabbitmq_export_password"
    --from-literal=index-password="$rabbitmq_index_password"
    --from-literal=api-url="$rabbitmq_api_url"
    --from-literal=import-url="$rabbitmq_import_url"
    --from-literal=export-url="$rabbitmq_export_url"
    --from-literal=index-url="$rabbitmq_index_url"
  )
  if [ "$update_existing" = true ]; then
    kubectl "${rabbitmq_secret_args[@]}" --dry-run=client -o yaml | kubectl apply -f -
  else
    kubectl "${rabbitmq_secret_args[@]}"
  fi
}

case "${1:-}" in
  --rabbitmq-only)
    create_rabbitmq_secret true
    echo "RabbitMQ service credentials rotated. Run deploy/k8s/deploy.sh to roll them out."
    exit 0
    ;;
  "") ;;
  *)
    echo "usage: deploy/k8s/create-secrets.sh [--rabbitmq-only]" >&2
    exit 2
    ;;
esac

if kubectl -n nix get secret nix-db >/dev/null 2>&1; then
  echo "secret nix-db already exists in namespace nix - refusing to overwrite. Delete it" >&2
  echo "explicitly first if you really mean to start over." >&2
  exit 1
fi

# Hex, not base64: these passwords also get embedded in postgresql:// URLs below (the
# collab service parses its connection string with new URL() and refuses to start on a
# parse failure), and base64's +, / and = characters break that parse silently otherwise.
kubectl -n nix create secret generic nix-db \
  --from-literal=superuser-password="$(openssl rand -hex 24)" \
  --from-literal=app-password="$(openssl rand -hex 24)" \
  --from-literal=migrator-password="$(openssl rand -hex 24)" \
  --from-literal=collab-password="$(openssl rand -hex 24)"

# Core, collab and media must all carry the same value: it proves which service is calling.
# The user's own token still proves on whose behalf.
kubectl -n nix create secret generic nix-internal \
  --from-literal=secret="$(openssl rand -hex 32)" \
  --from-literal=public-forms-signing-key="$(openssl rand -hex 32)"

create_rabbitmq_secret false

: "${NIX_OBJECT_STORE_ENDPOINT:?set NIX_OBJECT_STORE_ENDPOINT to the production S3 endpoint}"
: "${NIX_OBJECT_STORE_BUCKET:?set NIX_OBJECT_STORE_BUCKET}"
: "${NIX_OBJECT_STORE_ACCESS_KEY:?set NIX_OBJECT_STORE_ACCESS_KEY}"
: "${NIX_OBJECT_STORE_SECRET_KEY:?set NIX_OBJECT_STORE_SECRET_KEY}"
kubectl -n nix create secret generic nix-object-store \
  --from-literal=endpoint="$NIX_OBJECT_STORE_ENDPOINT" \
  --from-literal=region="${NIX_OBJECT_STORE_REGION:-us-east-1}" \
  --from-literal=bucket="$NIX_OBJECT_STORE_BUCKET" \
  --from-literal=access-key="$NIX_OBJECT_STORE_ACCESS_KEY" \
  --from-literal=secret-key="$NIX_OBJECT_STORE_SECRET_KEY"

auth_key_file="$(mktemp)"
trap 'rm -f "$auth_key_file"' EXIT
openssl ecparam -name prime256v1 -genkey -noout -out "$auth_key_file"
kubectl -n nix create secret generic nix-auth \
  --from-file=access-token-signing-key.pem="$auth_key_file"

APP_PW=$(kubectl -n nix get secret nix-db -o jsonpath='{.data.app-password}' | base64 -d)
MIG_PW=$(kubectl -n nix get secret nix-db -o jsonpath='{.data.migrator-password}' | base64 -d)
COL_PW=$(kubectl -n nix get secret nix-db -o jsonpath='{.data.collab-password}' | base64 -d)

kubectl -n nix create secret generic nix-connections \
  --from-literal=core="Host=postgres;Port=5432;Database=nix;Username=nix_app;Password=$APP_PW" \
  --from-literal=migrator="Host=postgres;Port=5432;Database=nix;Username=nix_migrator;Password=$MIG_PW" \
  --from-literal=collab="postgresql://nix_collab:$COL_PW@postgres:5432/nix" \
  --from-literal=collab-migrator="postgresql://nix_migrator:$MIG_PW@postgres:5432/nix"

kubectl -n nix create configmap nix-seed \
  --from-file=seed.sql=deploy/seed/seed.sql \
  --from-file=seed_database.sql=deploy/seed/seed_database.sql

echo "Secrets and seed ConfigMap created. Next: deploy/k8s/deploy.sh"
