#!/usr/bin/env bash
# Applies a Nix release to k3s, in the order that keeps a bad step from reaching users:
# database -> seed -> migrations (both must succeed) -> workloads -> ingress.
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

: "${REGISTRY:?set REGISTRY, matching what build-and-push.sh pushed to}"
: "${TAG:?set TAG, matching what build-and-push.sh pushed}"
: "${OIDC_ISSUER:?set OIDC_ISSUER, e.g. https://id.example.com (origin only, no path)}"
: "${OIDC_CLIENT_ID:?set OIDC_CLIENT_ID}"
: "${DOMAIN:?set DOMAIN, e.g. nix.example.com}"
export POD_CIDR="${POD_CIDR:-10.42.0.0/16}"
export REGISTRY TAG OIDC_ISSUER OIDC_CLIENT_ID DOMAIN

render() { envsubst '${REGISTRY} ${TAG} ${OIDC_ISSUER} ${OIDC_CLIENT_ID} ${DOMAIN} ${POD_CIDR}' < "$1"; }

if ! kubectl -n nix get secret nix-db >/dev/null 2>&1; then
  echo "secret nix-db not found in namespace nix - run deploy/k8s/create-secrets.sh first" >&2
  exit 1
fi

echo "== Postgres =="
kubectl apply -f deploy/k8s/postgres.yaml
kubectl -n nix rollout status statefulset/postgres --timeout=180s

echo "== Seed =="
kubectl apply -f deploy/k8s/job-seed.yaml
kubectl -n nix wait --for=condition=complete job/nix-db-seed --timeout=180s

echo "== Migrations (tag $TAG) =="
render deploy/k8s/job-migrate.yaml | kubectl apply -f -
kubectl -n nix wait --for=condition=complete "job/nix-migrate-$TAG" --timeout=300s
kubectl -n nix wait --for=condition=complete "job/nix-migrate-documents-$TAG" --timeout=300s

echo "== Caddyfile =="
kubectl -n nix create configmap nix-caddy --from-file=Caddyfile=deploy/k8s/Caddyfile \
  --dry-run=client -o yaml | kubectl apply -f -

echo "== Workloads =="
render deploy/k8s/api.yaml | kubectl apply -f -
render deploy/k8s/collab.yaml | kubectl apply -f -
render deploy/k8s/media.yaml | kubectl apply -f -
render deploy/k8s/web.yaml | kubectl apply -f -

kubectl -n nix rollout status deployment/nix-api --timeout=180s
kubectl -n nix rollout status deployment/nix-collab --timeout=180s
kubectl -n nix rollout status deployment/nix-media --timeout=180s
kubectl -n nix rollout status deployment/nix-web --timeout=180s

echo "== Ingress =="
render deploy/k8s/ingress.yaml | kubectl apply -f -

echo "Deployed tag $TAG. Next: DOMAIN=$DOMAIN deploy/k8s/verify.sh"
