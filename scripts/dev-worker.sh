#!/usr/bin/env bash
# Starts the one local Go worker process with every production role enabled.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root/apps/go-workers"

export NIX_WORKER_API_URL="${NIX_WORKER_API_URL:-http://localhost:5014}"
export NIX_WORKER_COLLAB_URL="${NIX_WORKER_COLLAB_URL:-http://localhost:8100}"
export NIX_WORKER_INTERNAL_SECRET="${NIX_WORKER_INTERNAL_SECRET:-nix-dev-internal}"
export NIX_RABBITMQ_URL="${NIX_RABBITMQ_URL:-amqp://nix:nix-dev-rabbit@localhost:5673/nix}"
export NIX_WORKER_OBJECT_ORIGINS="${NIX_WORKER_OBJECT_ORIGINS:-http://localhost:7070}"
export NIX_WORKER_ROLES="${NIX_WORKER_ROLES:-import,export,index}"
export NIX_WORKER_ADDRESS="${NIX_WORKER_ADDRESS:-:8301}"

exec go run ./cmd/nix-worker
