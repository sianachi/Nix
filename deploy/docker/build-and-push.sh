#!/usr/bin/env bash
# Builds and pushes all four Nix images for a k3s deployment.
#
# Run from the repository root:
#   REGISTRY=ghcr.io/you/nix PLATFORM=linux/arm64 \
#   deploy/docker/build-and-push.sh
#
# PLATFORM must match the cluster node's architecture. @nix/media depends on
# @resvg/resvg-js, a native module - an amd64 image will not run on an arm64 node
# (a Jetson, a Raspberry Pi). Defaults to linux/arm64 since that is this project's
# current k3s target; override for an amd64 node.
#
# Tags with the commit SHA, never "latest" - imagePullPolicy: IfNotPresent plus a
# floating tag is how a cluster silently keeps running the previous build.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

: "${REGISTRY:?set REGISTRY, e.g. ghcr.io/you/nix}"
PLATFORM="${PLATFORM:-linux/arm64}"
TAG="${TAG:-$(git rev-parse --short HEAD)}"

echo "Building $REGISTRY/{api,migrator,collab,media,import-worker,export-worker,indexer,web}:$TAG for $PLATFORM"

docker buildx build --platform "$PLATFORM" --target api \
  -f deploy/docker/backend.Dockerfile -t "$REGISTRY/api:$TAG" --push .

docker buildx build --platform "$PLATFORM" --target migrator \
  -f deploy/docker/backend.Dockerfile -t "$REGISTRY/migrator:$TAG" --push .

docker buildx build --platform "$PLATFORM" --target collab \
  -f deploy/docker/node.Dockerfile -t "$REGISTRY/collab:$TAG" --push .

docker buildx build --platform "$PLATFORM" --target media \
  -f deploy/docker/node.Dockerfile -t "$REGISTRY/media:$TAG" --push .

for worker in import-worker export-worker indexer; do
  case "$worker" in
    import-worker) command='./cmd/nix-import-worker' ;;
    export-worker) command='./cmd/nix-export-worker' ;;
    indexer) command='./cmd/nix-indexer' ;;
  esac
  docker buildx build --platform "$PLATFORM" \
    --build-arg "WORKER_CMD=$command" \
    -f deploy/docker/go-workers.Dockerfile -t "$REGISTRY/$worker:$TAG" --push .
done

docker buildx build --platform "$PLATFORM" --target web \
  -f deploy/docker/web.Dockerfile \
  -t "$REGISTRY/web:$TAG" --push .

echo "Built and pushed tag $TAG. Deploy with:"
echo "  REGISTRY=$REGISTRY TAG=$TAG deploy/k8s/deploy.sh"
