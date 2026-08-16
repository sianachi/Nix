#!/usr/bin/env bash
# One-time setup: generates the four secrets a Nix deployment needs and the derived
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
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

kubectl get namespace nix >/dev/null 2>&1 || kubectl apply -f deploy/k8s/namespace.yaml

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
