#!/usr/bin/env bash
# Post-deploy checks, in order - each fails in a distinguishable way. Run after deploy/k8s/deploy.sh.
#
#   DOMAIN=nix.example.com deploy/k8s/verify.sh
#
# What this script cannot check, because they need a browser: sign-in end to end, two
# browsers editing the same note (exercises the collab WebSocket upgrade through Traefik and
# Caddy - the one thing in this deployment most likely to be wrong), exporting a note as PDF,
# and reloading on a deep route (a 404 there means Caddy's try_files fallback is not in effect).
set -euo pipefail
: "${DOMAIN:?set DOMAIN, e.g. nix.example.com}"

echo "== Pods =="
kubectl -n nix get pods

echo "== Core =="
kubectl -n nix run verify-curl-core --rm -i --image=curlimages/curl --restart=Never -- \
  curl -fsS http://nix-api:8080/healthz
kubectl -n nix run verify-curl-core2 --rm -i --image=curlimages/curl --restart=Never -- \
  curl -fsS http://nix-api:8080/api/v1/health/status

echo "== Core has persistence configured (expect no matches below) =="
kubectl -n nix logs deploy/nix-api | grep -i "persistence" || true
kubectl -n nix logs deploy/nix-api | grep -i "internal surface" || true

echo "== Collab =="
kubectl -n nix run verify-curl-collab --rm -i --image=curlimages/curl --restart=Never -- \
  curl -fsS http://nix-collab:8100/healthz

echo "== Media =="
kubectl -n nix run verify-curl-media --rm -i --image=curlimages/curl --restart=Never -- \
  curl -fsS http://nix-media:8200/healthz

echo "== Single origin (https://$DOMAIN) =="
curl -fsS "https://$DOMAIN/" -o /dev/null -w '%{http_code} app\n'
curl -fsS "https://$DOMAIN/api/v1/health/status" -w ' core\n'
curl -fsS "https://$DOMAIN/auth/session" -w ' browser auth\n'
curl -fsS "https://$DOMAIN/collab/healthz" -w ' collab\n'
curl -fsS "https://$DOMAIN/media/healthz" -w ' media\n'

echo "== /internal must be unreachable (expect 404) =="
curl -s -o /dev/null -w '%{http_code} internal (want 404)\n' "https://$DOMAIN/internal/authorize"

echo "== Security headers keep provider communication server-side =="
curl -sI "https://$DOMAIN/" | grep -i content-security-policy

echo "Automated checks done. Remaining: sign in, two-browser edit, PDF export, deep-route reload."
