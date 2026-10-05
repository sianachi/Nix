#!/usr/bin/env bash
# Build immutable local Compose images from a committed tree, without copying secrets.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
ref=${1:-HEAD}
sha=$(git -C "$root" rev-parse --verify "$ref^{commit}")
context=$(mktemp -d)
trap 'rm -rf "$context"' EXIT
git -C "$root" archive "$sha" | tar -x -C "$context"
for target in api migrator; do
  docker build --target "$target" -f "$context/deploy/docker/backend.Dockerfile" -t "localhost/nix/$target:$sha" "$context"
done
docker build --target collab -f "$context/deploy/docker/node.Dockerfile" -t "localhost/nix/collab:$sha" "$context"
docker build -f "$context/deploy/docker/go-workers.Dockerfile" -t "localhost/nix/worker:$sha" "$context"
# The speech images are optional and slow to build (whisper.cpp from source; the Jetson build pulls
# NVIDIA's base images). Ask for them only where the speech profile is deployed.
case "${NIX_BUILD_SPEECH:-}" in
  cpu) docker build -f "$context/deploy/docker/speech-worker.Dockerfile" -t "localhost/nix/speech-worker:$sha" "$context" ;;
  l4t) docker build -f "$context/deploy/docker/speech-worker.l4t.Dockerfile" -t "localhost/nix/speech-worker-l4t:$sha" "$context" ;;
  '') ;;
  *) echo 'NIX_BUILD_SPEECH must be cpu or l4t' >&2; exit 2 ;;
esac
docker build --target web -f "$context/deploy/docker/web.Dockerfile" -t "localhost/nix/web:$sha" "$context"
docker build --target release-tools -f "$context/deploy/docker/release-tools.Dockerfile" -t "localhost/nix/release-tools:$sha" "$context"
printf 'Built Compose release %s. Set NIX_IMAGE_TAG and NIX_WEB_IMAGE_TAG to this SHA.\n' "$sha"
