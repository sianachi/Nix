#!/usr/bin/env bash
# Applies a Nix release to k3s, in the order that keeps a bad step from reaching users:
# database -> seed -> migrations -> preset reconciliation -> workloads -> ingress.
#
# Run deploy/k8s/create-secrets.sh once per cluster before the first run of this script.
# Run deploy/docker/build-and-push.sh first each time, with the same REGISTRY and TAG.
#
#   REGISTRY=ghcr.io/you/nix TAG=$(git rev-parse --short HEAD) \
#   OIDC_ISSUER=https://id.example.com OIDC_CLIENT_ID=your-client-id \
#   DOMAIN=nix.example.com \
#   deploy/k8s/deploy.sh
#
# POD_CIDR defaults to k3s's stock Flannel range (10.42.0.0/16) - confirm yours with:
#   kubectl -n kube-system get configmap -o yaml | grep -i cluster-cidr
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
source deploy/k8s/template-boot-config.sh

: "${REGISTRY:?set REGISTRY, matching what build-and-push.sh pushed to}"
: "${TAG:?set TAG, matching what build-and-push.sh pushed}"
: "${OIDC_ISSUER:?set OIDC_ISSUER, e.g. https://id.example.com (origin only, no path)}"
: "${OIDC_CLIENT_ID:?set OIDC_CLIENT_ID}"
: "${DOMAIN:?set DOMAIN, e.g. nix.example.com}"
require_template_boot_config
export POD_CIDR="${POD_CIDR:-10.42.0.0/16}"
export NIX_SEARCH_OPENSEARCH_ENABLED="${NIX_SEARCH_OPENSEARCH_ENABLED:-false}"
export REGISTRY TAG OIDC_ISSUER OIDC_CLIENT_ID DOMAIN NIX_SEARCH_OPENSEARCH_ENABLED

render() { envsubst '${REGISTRY} ${TAG} ${OIDC_ISSUER} ${OIDC_CLIENT_ID} ${DOMAIN} ${POD_CIDR} ${RABBITMQ_SECRET_VERSION} ${NIX_SEARCH_OPENSEARCH_ENABLED} ${TEMPLATE_BOOT_WORKSPACE_ID} ${TEMPLATE_BOOT_OIDC_AUDIENCE} ${TEMPLATE_BOOT_OIDC_SCOPE} ${TEMPLATE_BOOT_PVC} ${TEMPLATE_BOOT_SERVICE_KEY_SECRET}' < "$1"; }

if ! kubectl -n nix get secret nix-db >/dev/null 2>&1; then
  echo "secret nix-db not found in namespace nix - run deploy/k8s/create-secrets.sh first" >&2
  exit 1
fi
if ! kubectl -n nix get secret nix-auth >/dev/null 2>&1; then
  echo "secret nix-auth not found in namespace nix - run deploy/k8s/create-secrets.sh first" >&2
  exit 1
fi
if ! kubectl -n nix get secret nix-rabbitmq >/dev/null 2>&1; then
  echo "secret nix-rabbitmq not found in namespace nix - run deploy/k8s/create-secrets.sh first" >&2
  exit 1
fi
for rabbitmq_key in api-password import-password export-password index-password api-url import-url export-url index-url; do
  rabbitmq_value="$(kubectl -n nix get secret nix-rabbitmq -o "jsonpath={.data['$rabbitmq_key']}")"
  if [ -z "$rabbitmq_value" ]; then
    echo "secret nix-rabbitmq is missing $rabbitmq_key - run deploy/k8s/create-secrets.sh --rabbitmq-only" >&2
    exit 1
  fi
done
RABBITMQ_SECRET_VERSION="$(kubectl -n nix get secret nix-rabbitmq -o jsonpath='{.metadata.resourceVersion}')"
if [ -z "$RABBITMQ_SECRET_VERSION" ]; then
  echo "secret nix-rabbitmq has no resource version" >&2
  exit 1
fi
export RABBITMQ_SECRET_VERSION

echo "== Postgres =="
kubectl apply -f deploy/k8s/postgres.yaml
kubectl -n nix rollout status statefulset/postgres --timeout=180s

echo "== RabbitMQ =="
kubectl -n nix create configmap nix-rabbitmq-config \
  --from-file=rabbitmq.conf=deploy/rabbitmq/rabbitmq.conf \
  --from-file=definitions.json=deploy/rabbitmq/definitions.json \
  --from-file=start.sh=deploy/rabbitmq/start.sh \
  --dry-run=client -o yaml | kubectl apply -f -
render deploy/k8s/rabbitmq.yaml | kubectl apply -f -
kubectl -n nix rollout status statefulset/nix-rabbitmq --timeout=180s

echo "== OpenSearch =="
kubectl apply -f deploy/k8s/opensearch.yaml
kubectl -n nix rollout status statefulset/nix-opensearch --timeout=300s

echo "== Seed =="
kubectl apply -f deploy/k8s/job-seed.yaml
kubectl -n nix wait --for=condition=complete job/nix-db-seed --timeout=180s

echo "== Migrations (tag $TAG) =="
render deploy/k8s/job-migrate.yaml | kubectl apply -f -
kubectl -n nix wait --for=condition=complete "job/nix-migrate-$TAG" --timeout=300s
kubectl -n nix wait --for=condition=complete "job/nix-migrate-documents-$TAG" --timeout=300s

echo "== Template presets (tag $TAG) =="
kubectl -n nix delete "job/nix-template-presets-$TAG" --ignore-not-found
kubectl -n nix create configmap nix-template-presets \
  --from-file=seed_template_presets.sql=deploy/seed/seed_template_presets.sql \
  --dry-run=client -o yaml | kubectl apply -f -
render deploy/k8s/job-template-presets.yaml | kubectl apply -f -
if ! kubectl -n nix wait --for=condition=complete "job/nix-template-presets-$TAG" --timeout=180s; then
  kubectl -n nix describe "job/nix-template-presets-$TAG" >&2 || true
  kubectl -n nix logs -l job-name="nix-template-presets-$TAG" --tail=200 >&2 || true
  exit 1
fi

echo "== Caddyfile =="
kubectl -n nix create configmap nix-caddy --from-file=Caddyfile=deploy/k8s/Caddyfile \
  --dry-run=client -o yaml | kubectl apply -f -

echo "== Workloads =="
render deploy/k8s/api.yaml | kubectl apply -f -
render deploy/k8s/collab.yaml | kubectl apply -f -
render deploy/k8s/media.yaml | kubectl apply -f -
render deploy/k8s/worker.yaml | kubectl apply -f -
render deploy/k8s/web.yaml | kubectl apply -f -

kubectl -n nix rollout status deployment/nix-api --timeout=180s
kubectl -n nix rollout status deployment/nix-collab --timeout=180s
kubectl -n nix rollout status deployment/nix-media --timeout=180s
kubectl -n nix rollout status deployment/nix-import-worker --timeout=180s
kubectl -n nix rollout status deployment/nix-export-worker --timeout=180s
kubectl -n nix rollout status deployment/nix-indexer --timeout=180s
kubectl -n nix rollout status deployment/nix-web --timeout=180s

kubectl -n nix get "persistentvolumeclaim/$TEMPLATE_BOOT_PVC" >/dev/null
kubectl -n nix get "secret/$TEMPLATE_BOOT_SERVICE_KEY_SECRET" >/dev/null

kubectl -n nix create configmap nix-template-boot-script \
  --from-file=sync-managed-templates.mjs=deploy/template-sync/sync-managed-templates.mjs \
  --dry-run=client -o yaml | kubectl apply -f -

echo "== Managed templates (tag $TAG) =="
kubectl -n nix delete "job/nix-template-boot-$TAG" --ignore-not-found
render deploy/k8s/job-template-sync.yaml | kubectl apply -f -
if ! kubectl -n nix wait --for=condition=complete "job/nix-template-boot-$TAG" --timeout=300s; then
  kubectl -n nix describe "job/nix-template-boot-$TAG" >&2 || true
  kubectl -n nix get pods -l job-name="nix-template-boot-$TAG" -o wide >&2 || true
  kubectl -n nix logs -l job-name="nix-template-boot-$TAG" --all-containers --tail=200 >&2 || true
  exit 1
fi

echo "== Ingress =="
render deploy/k8s/ingress.yaml | kubectl apply -f -

echo "Deployed tag $TAG. Next: DOMAIN=$DOMAIN deploy/k8s/verify.sh"
