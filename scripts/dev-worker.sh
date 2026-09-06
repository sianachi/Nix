#!/usr/bin/env bash
# Starts the one local Go worker process with every production role enabled.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root/apps/go-workers"

export NIX_API_PORT="${NIX_API_PORT:-5014}"
export NIX_API_ORIGIN="${NIX_API_ORIGIN:-http://localhost:${NIX_API_PORT}}"
export NIX_COLLAB_PORT="${NIX_COLLAB_PORT:-8100}"
export NIX_COLLAB_ORIGIN="${NIX_COLLAB_ORIGIN:-http://localhost:${NIX_COLLAB_PORT}}"
export NIX_WORKER_API_URL="${NIX_WORKER_API_URL:-$NIX_API_ORIGIN}"
export NIX_WORKER_COLLAB_URL="${NIX_WORKER_COLLAB_URL:-$NIX_COLLAB_ORIGIN}"
export NIX_WORKER_INTERNAL_SECRET="${NIX_WORKER_INTERNAL_SECRET:-nix-dev-internal}"
export NIX_WORKER_OBJECT_ORIGINS="${NIX_WORKER_OBJECT_ORIGINS:-http://localhost:7070}"
export NIX_WORKER_ROLES="${NIX_WORKER_ROLES:-import,export,index,plugin-events}"
export NIX_WORKER_ADDRESS="${NIX_WORKER_ADDRESS:-:8301}"
export NIX_OPENSEARCH_URL="${NIX_OPENSEARCH_URL:-http://localhost:${NIX_OPENSEARCH_PORT:-9201}}"
export NIX_OPENSEARCH_INDEX="${NIX_OPENSEARCH_INDEX:-nix-items}"

if [ -z "${NIX_RABBITMQ_URL:-}" ]; then
  case "$NIX_WORKER_ROLES" in
    import)
      NIX_RABBITMQ_URL="${NIX_RABBITMQ_IMPORT_URL:-amqp://nix-import:nix-dev-import-rabbit@localhost:5673/%2Fnix}"
      ;;
    export)
      NIX_RABBITMQ_URL="${NIX_RABBITMQ_EXPORT_URL:-amqp://nix-export:nix-dev-export-rabbit@localhost:5673/%2Fnix}"
      ;;
    index)
      NIX_RABBITMQ_URL="${NIX_RABBITMQ_INDEX_URL:-amqp://nix-index:nix-dev-index-rabbit@localhost:5673/%2Fnix}"
      ;;
    plugin-events)
      NIX_RABBITMQ_URL="${NIX_RABBITMQ_PLUGIN_URL:-amqp://nix-plugin:nix-dev-plugin-rabbit@localhost:5673/%2Fnix}"
      ;;
    *)
      # The combined account exists only in the local stack and has worker permissions, not
      # topology or API permissions. Production runs one role per deployment and never creates it.
      NIX_RABBITMQ_URL="${NIX_RABBITMQ_DEV_WORKER_URL:-amqp://nix-worker-dev:nix-dev-combined-worker-rabbit@localhost:5673/%2Fnix}"
      ;;
  esac
  export NIX_RABBITMQ_URL
fi

exec go run ./cmd/nix-worker
