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
# Existing clusters can update an external service secret without touching database or signing
# secrets by running this script with `--rabbitmq-only`, `--object-store-only`, `--sites-only`,
# `--tls-only` or `--zitadel-only` (creates the identity provider's secret only when missing). Production values (keys, certificate paths) come from the operator's local,
# uncommitted environment, never from this repository.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

kubectl get namespace nix >/dev/null 2>&1 || kubectl apply -f deploy/k8s/namespace.yaml

create_rabbitmq_secret() {
  local update_existing="$1"
  local rabbitmq_api_password rabbitmq_import_password rabbitmq_export_password rabbitmq_plugin_password rabbitmq_calendar_password rabbitmq_notify_password rabbitmq_sites_password rabbitmq_worker_password
  local rabbitmq_api_url rabbitmq_import_url rabbitmq_export_url rabbitmq_plugin_url rabbitmq_calendar_url rabbitmq_notify_url rabbitmq_sites_url rabbitmq_worker_url rabbitmq_url

  rabbitmq_api_password="$(openssl rand -hex 24)"
  rabbitmq_import_password="$(openssl rand -hex 24)"
  rabbitmq_export_password="$(openssl rand -hex 24)"
  rabbitmq_plugin_password="$(openssl rand -hex 24)"
  rabbitmq_calendar_password="$(openssl rand -hex 24)"
  rabbitmq_notify_password="$(openssl rand -hex 24)"
  rabbitmq_sites_password="$(openssl rand -hex 24)"
  rabbitmq_worker_password="$(openssl rand -hex 24)"

  # The defaults are intentionally plaintext only across the namespace-internal NetworkPolicy.
  # Supplying all full amqps:// URLs moves application traffic to an external TLS broker while
  # retaining independent identities. Port 443 is already permitted by the worker egress policy.
  rabbitmq_api_url="${NIX_RABBITMQ_API_URL:-amqp://nix-api:$rabbitmq_api_password@nix-rabbitmq:5672/%2Fnix}"
  rabbitmq_import_url="${NIX_RABBITMQ_IMPORT_URL:-amqp://nix-import:$rabbitmq_import_password@nix-rabbitmq:5672/%2Fnix}"
  rabbitmq_export_url="${NIX_RABBITMQ_EXPORT_URL:-amqp://nix-export:$rabbitmq_export_password@nix-rabbitmq:5672/%2Fnix}"
  rabbitmq_plugin_url="${NIX_RABBITMQ_PLUGIN_URL:-amqp://nix-plugin:$rabbitmq_plugin_password@nix-rabbitmq:5672/%2Fnix}"
  rabbitmq_calendar_url="${NIX_RABBITMQ_CALENDAR_URL:-amqp://nix-calendar:$rabbitmq_calendar_password@nix-rabbitmq:5672/%2Fnix}"
  rabbitmq_notify_url="${NIX_RABBITMQ_NOTIFY_URL:-amqp://nix-notify:$rabbitmq_notify_password@nix-rabbitmq:5672/%2Fnix}"
  rabbitmq_sites_url="${NIX_RABBITMQ_SITES_URL:-amqp://nix-sites:$rabbitmq_sites_password@nix-rabbitmq:5672/%2Fnix}"
  # The combined Go worker (deploy/k8s/worker.yaml) connects as nix-worker.
  rabbitmq_worker_url="${NIX_RABBITMQ_WORKER_URL:-amqp://nix-worker:$rabbitmq_worker_password@nix-rabbitmq:5672/%2Fnix}"
  for rabbitmq_url in "$rabbitmq_api_url" "$rabbitmq_import_url" "$rabbitmq_export_url" "$rabbitmq_plugin_url" "$rabbitmq_calendar_url" "$rabbitmq_notify_url" "$rabbitmq_sites_url" "$rabbitmq_worker_url"; do
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
    --from-literal=plugin-password="$rabbitmq_plugin_password"
    --from-literal=calendar-password="$rabbitmq_calendar_password"
    --from-literal=notify-password="$rabbitmq_notify_password"
    --from-literal=sites-password="$rabbitmq_sites_password"
    --from-literal=worker-password="$rabbitmq_worker_password"
    --from-literal=api-url="$rabbitmq_api_url"
    --from-literal=import-url="$rabbitmq_import_url"
    --from-literal=export-url="$rabbitmq_export_url"
    --from-literal=plugin-url="$rabbitmq_plugin_url"
    --from-literal=calendar-url="$rabbitmq_calendar_url"
    --from-literal=notify-url="$rabbitmq_notify_url"
    --from-literal=sites-url="$rabbitmq_sites_url"
    --from-literal=worker-url="$rabbitmq_worker_url"
  )
  if [ "$update_existing" = true ]; then
    kubectl "${rabbitmq_secret_args[@]}" --dry-run=client -o yaml | kubectl apply -f -
  else
    kubectl "${rabbitmq_secret_args[@]}"
  fi
}

create_object_store_secret() {
  local update_existing="$1"

  # Defaults describe the in-cluster versitygw (deploy/k8s/objectstore.yaml): browsers reach it on
  # the app origin through Caddy, and the generated pair becomes its root account. Set every value
  # to point at an external S3 store instead. Re-running rotates the generated pair.
  if [ -z "${NIX_OBJECT_STORE_PUBLIC_ORIGIN:-}" ]; then
    : "${DOMAIN:?set DOMAIN (the app origin serves capability URLs) or NIX_OBJECT_STORE_PUBLIC_ORIGIN}"
  fi
  NIX_OBJECT_STORE_ENDPOINT="${NIX_OBJECT_STORE_ENDPOINT:-http://nix-versitygw:7070}"
  NIX_OBJECT_STORE_PUBLIC_ORIGIN="${NIX_OBJECT_STORE_PUBLIC_ORIGIN:-https://$DOMAIN}"
  NIX_OBJECT_STORE_BUCKET="${NIX_OBJECT_STORE_BUCKET:-nix-worker-jobs}"
  NIX_OBJECT_STORE_ACCESS_KEY="${NIX_OBJECT_STORE_ACCESS_KEY:-nix-root-$(openssl rand -hex 8)}"
  NIX_OBJECT_STORE_SECRET_KEY="${NIX_OBJECT_STORE_SECRET_KEY:-$(openssl rand -hex 32)}"

  local -a object_store_secret_args=(
    -n nix create secret generic nix-object-store
    --from-literal=endpoint="$NIX_OBJECT_STORE_ENDPOINT"
    --from-literal=public-origin="$NIX_OBJECT_STORE_PUBLIC_ORIGIN"
    --from-literal=region="${NIX_OBJECT_STORE_REGION:-us-east-1}"
    --from-literal=bucket="$NIX_OBJECT_STORE_BUCKET"
    --from-literal=access-key="$NIX_OBJECT_STORE_ACCESS_KEY"
    --from-literal=secret-key="$NIX_OBJECT_STORE_SECRET_KEY"
  )
  if [ "$update_existing" = true ]; then
    kubectl "${object_store_secret_args[@]}" --dry-run=client -o yaml | kubectl apply -f -
  else
    kubectl "${object_store_secret_args[@]}"
  fi
}

# Calendar sync OAuth clients (ADR-0052). Every value is optional: a provider without a client id
# and secret is reported unavailable. The api Deployment reads this secret with optional keys, so a
# cluster without it still starts. Redirect URIs to register at the providers:
#   https://$DOMAIN/auth/calendar/callback/google and https://$DOMAIN/auth/calendar/callback/microsoft
create_calendar_secret() {
  local update_existing="$1"
  local -a calendar_secret_args=(
    -n nix create secret generic nix-calendar
    --from-literal=google-client-id="${NIX_CALENDAR_GOOGLE_CLIENT_ID:-}"
    --from-literal=google-client-secret="${NIX_CALENDAR_GOOGLE_CLIENT_SECRET:-}"
    --from-literal=microsoft-client-id="${NIX_CALENDAR_MICROSOFT_CLIENT_ID:-}"
    --from-literal=microsoft-client-secret="${NIX_CALENDAR_MICROSOFT_CLIENT_SECRET:-}"
    --from-literal=microsoft-tenant="${NIX_CALENDAR_MICROSOFT_TENANT:-common}"
  )
  if [ "$update_existing" = true ]; then
    kubectl "${calendar_secret_args[@]}" --dry-run=client -o yaml | kubectl apply -f -
  else
    kubectl "${calendar_secret_args[@]}"
  fi
}

# Sites (ADR-0063). Core signs the sites worker's uploads with the object-store key above. Serve
# gets a separate key that can only read the sites bucket: by default a generated versitygw account
# that deploy/k8s/job-storage-init.yaml creates and scopes with a bucket policy; on an external store
# such as Cloudflare R2, supply an "Object Read only" token scoped to the bucket. The reserved
# owners are optional workspace UUIDs allowed to claim the slugs nix and osinachi.
create_sites_secret() {
  local update_existing="$1"

  NIX_SITES_READ_ACCESS_KEY="${NIX_SITES_READ_ACCESS_KEY:-nix-sites-read-$(openssl rand -hex 6)}"
  NIX_SITES_READ_SECRET_KEY="${NIX_SITES_READ_SECRET_KEY:-$(openssl rand -hex 32)}"
  if [ "$NIX_SITES_READ_ACCESS_KEY" = "${NIX_OBJECT_STORE_ACCESS_KEY:-}" ]; then
    echo "NIX_SITES_READ_ACCESS_KEY must not be the object store's write key." >&2
    exit 1
  fi

  local -a sites_secret_args=(
    -n nix create secret generic nix-sites
    --from-literal=bucket="${NIX_SITES_BUCKET:-nix-sites}"
    --from-literal=read-access-key="$NIX_SITES_READ_ACCESS_KEY"
    --from-literal=read-secret-key="$NIX_SITES_READ_SECRET_KEY"
  )
  # An empty value would fail Core's Guid binding, so an unset owner leaves the key out.
  if [ -n "${NIX_SITES_RESERVED_OWNER_NIX:-}" ]; then
    sites_secret_args+=(--from-literal=reserved-owner-nix="$NIX_SITES_RESERVED_OWNER_NIX")
  fi
  if [ -n "${NIX_SITES_RESERVED_OWNER_OSINACHI:-}" ]; then
    sites_secret_args+=(--from-literal=reserved-owner-osinachi="$NIX_SITES_RESERVED_OWNER_OSINACHI")
  fi
  if [ "$update_existing" = true ]; then
    kubectl "${sites_secret_args[@]}" --dry-run=client -o yaml | kubectl apply -f -
  else
    kubectl "${sites_secret_args[@]}"
  fi
}

# Cloudflare Origin CA certificate for $DOMAIN and *.$DOMAIN (which covers auth.$DOMAIN), read
# from local files.
create_tls_secret() {
  : "${NIX_ORIGIN_TLS_CERT_FILE:?set NIX_ORIGIN_TLS_CERT_FILE to the origin certificate PEM}"
  : "${NIX_ORIGIN_TLS_KEY_FILE:?set NIX_ORIGIN_TLS_KEY_FILE to its private key PEM}"
  kubectl -n nix create secret tls nix-tls \
    --cert="$NIX_ORIGIN_TLS_CERT_FILE" --key="$NIX_ORIGIN_TLS_KEY_FILE" \
    --dry-run=client -o yaml | kubectl apply -f -
}

# Zitadel (deploy/k8s/zitadel.yaml). Created once and never rotated here: the masterkey encrypts
# Zitadel's stored secrets, so replacing it makes the instance unreadable. The first administrator's
# password is generated unless NIX_ZITADEL_ADMIN_PASSWORD is set, and must be changed at first sign-in.
create_zitadel_secret() {
  if kubectl -n nix get secret nix-zitadel >/dev/null 2>&1; then
    echo "secret nix-zitadel already exists - leaving it (its masterkey must never change)."
    return 0
  fi
  local admin_password="${NIX_ZITADEL_ADMIN_PASSWORD:-$(openssl rand -hex 12)Aa1!}"
  kubectl -n nix create secret generic nix-zitadel \
    --from-literal=masterkey="$(openssl rand -hex 16)" \
    --from-literal=db-password="$(openssl rand -hex 24)" \
    --from-literal=admin-username="${NIX_ZITADEL_ADMIN_USERNAME:-admin}" \
    --from-literal=admin-password="$admin_password"
  echo "Zitadel administrator: kubectl -n nix get secret nix-zitadel -o jsonpath='{.data.admin-password}' | base64 -d"
}

case "${1:-}" in
  --zitadel-only)
    create_zitadel_secret
    exit 0
    ;;
  --rabbitmq-only)
    create_rabbitmq_secret true
    echo "RabbitMQ service credentials rotated. Run deploy/k8s/deploy.sh to roll them out."
    exit 0
    ;;
  --object-store-only)
    create_object_store_secret true
    echo "Object-store configuration updated. Run deploy/k8s/deploy.sh to roll it out."
    exit 0
    ;;
  --calendar-only)
    create_calendar_secret true
    echo "Calendar OAuth clients updated. Run deploy/k8s/deploy.sh to roll them out."
    exit 0
    ;;
  --sites-only)
    create_sites_secret true
    echo "Sites configuration updated. Run deploy/k8s/deploy.sh to roll it out."
    exit 0
    ;;
  --tls-only)
    create_tls_secret
    echo "Origin certificate updated."
    exit 0
    ;;
  "") ;;
  *)
    echo "usage: deploy/k8s/create-secrets.sh [--rabbitmq-only|--object-store-only|--calendar-only|--sites-only|--tls-only|--zitadel-only]" >&2
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

# Core and every internal service must carry the same value: it proves which service is calling.
# The user's own token still proves on whose behalf.
kubectl -n nix create secret generic nix-internal \
  --from-literal=secret="$(openssl rand -hex 32)" \
  --from-literal=public-forms-signing-key="$(openssl rand -hex 32)"

create_rabbitmq_secret false
create_object_store_secret false
create_calendar_secret false
create_sites_secret false
create_tls_secret
create_zitadel_secret

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
