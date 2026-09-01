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

echo "== RabbitMQ =="
kubectl -n nix exec statefulset/nix-rabbitmq -- rabbitmq-diagnostics -q check_running
kubectl -n nix exec statefulset/nix-rabbitmq -- rabbitmq-diagnostics -q check_virtual_hosts
rabbitmq_users="$(kubectl -n nix exec statefulset/nix-rabbitmq -- rabbitmqctl list_users --no-table-headers)"
for rabbitmq_user in nix-api nix-import nix-export nix-index; do
  if ! printf '%s\n' "$rabbitmq_users" | awk -v expected="$rabbitmq_user" '$1 == expected { found = 1 } END { exit !found }'; then
    echo "RabbitMQ user $rabbitmq_user is missing." >&2
    exit 1
  fi
done
for retired_user in nix guest nix-worker-dev nix-admin; do
  if printf '%s\n' "$rabbitmq_users" | awk -v expected="$retired_user" '$1 == expected { found = 1 } END { exit !found }'; then
    echo "Retired RabbitMQ user $retired_user is still present." >&2
    exit 1
  fi
done
rabbitmq_permissions="$(kubectl -n nix exec statefulset/nix-rabbitmq -- rabbitmqctl list_permissions --vhost /nix --no-table-headers)"
if printf '%s\n' "$rabbitmq_permissions" | awk '$1 ~ /^nix-(api|import|export|index)$/ && $2 == ".*" && $3 == ".*" && $4 == ".*" { found = 1 } END { exit !found }'; then
  echo "A RabbitMQ service user still has full-control permissions." >&2
  exit 1
fi
require_rabbitmq_permission() {
  local expected
  expected="$(printf '%s\t%s\t%s\t%s' "$1" "$2" "$3" "$4")"
  if ! printf '%s\n' "$rabbitmq_permissions" | grep -Fqx "$expected"; then
    echo "RabbitMQ permissions for $1 do not match the deployment contract." >&2
    exit 1
  fi
}
require_rabbitmq_permission nix-api \
  '^amq\.gen-[A-Za-z0-9_-]+$' \
  '^(amq\.gen-[A-Za-z0-9_-]+|nix\.commands\.v1|nix\.workspace\.v1)$' \
  '^(amq\.gen-[A-Za-z0-9_-]+|nix\.api\.results\.v1|nix\.capabilities\.v1)$'
require_rabbitmq_permission nix-import '^$' '^nix\.results\.v1$' '^nix\.worker\.import\.v1$'
require_rabbitmq_permission nix-export '^$' \
  '^(nix\.results\.v1|nix\.capabilities\.v1)$' '^nix\.worker\.export\.v1$'
require_rabbitmq_permission nix-index '^$' '^$' '^nix\.worker\.index\.v1$'
rabbitmq_topic_permissions="$(kubectl -n nix exec statefulset/nix-rabbitmq -- rabbitmqctl list_topic_permissions --vhost /nix --no-table-headers)"
require_rabbitmq_topic_permission() {
  local expected
  expected="$(printf '%s\t%s\t%s\t%s' "$1" "$2" "$3" "$4")"
  if ! printf '%s\n' "$rabbitmq_topic_permissions" | grep -Fqx "$expected"; then
    echo "RabbitMQ topic permissions for $1 on $2 do not match the deployment contract." >&2
    exit 1
  fi
}
require_rabbitmq_topic_permission nix-api nix.commands.v1 \
  '^(import|file|object|export)\..+$' '^$'
require_rabbitmq_topic_permission nix-api nix.workspace.v1 '^.+$' '^$'
require_rabbitmq_topic_permission nix-api nix.capabilities.v1 '^$' '^#$'
require_rabbitmq_topic_permission nix-import nix.results.v1 '^job\.result$' '^$'
require_rabbitmq_topic_permission nix-export nix.results.v1 '^job\.result$' '^$'
require_rabbitmq_topic_permission nix-export nix.capabilities.v1 '^worker\.export$' '^$'
service_topic_permission_count="$(printf '%s\n' "$rabbitmq_topic_permissions" | awk '$1 ~ /^nix-(api|import|export|index)$/ { count += 1 } END { print count + 0 }')"
if [ "$service_topic_permission_count" -ne 6 ]; then
  echo "RabbitMQ service users have unexpected topic permissions." >&2
  exit 1
fi

echo "== Media =="
kubectl -n nix run verify-curl-media --rm -i --image=curlimages/curl --restart=Never -- \
  curl -fsS http://nix-media:8200/healthz

echo "== Go workers =="
for worker in import-worker export-worker indexer; do
  kubectl -n nix run "verify-curl-$worker" --rm -i --image=curlimages/curl --restart=Never -- \
    curl -fsS "http://nix-$worker:8301/healthz"
done

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
