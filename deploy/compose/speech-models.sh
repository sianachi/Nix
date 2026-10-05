#!/usr/bin/env bash
# Fill the speech role's models volume (ADR-0059). Run on the Compose host, once before the
# `speech` profile is first turned on and again whenever deploy/speech/models.sha256 changes.
#
# Every file named in the manifest is downloaded to a scratch directory, checked against the
# digest recorded for it in the repository, and only then copied into the volume. A file already
# in the volume with the right digest is left alone, so a second run downloads nothing. Nothing
# here is secret and nothing here is backed up: the volume can always be rebuilt from the manifest.
#
# Usage:
#   deploy/compose/speech-models.sh            fetch whatever is missing or wrong
#   deploy/compose/speech-models.sh --check    verify the volume and change nothing
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
manifest=${NIX_SPEECH_MODELS_MANIFEST:-$root/deploy/speech/models.sha256}
volume=${NIX_SPEECH_MODELS_VOLUME:-nix-speech-models}
# Any small image with a POSIX shell and sha256sum; nothing from it is kept.
helper=${NIX_SPEECH_MODELS_HELPER_IMAGE:-busybox:1.37}
check_only=0
case "${1:-}" in
  '') ;;
  --check) check_only=1 ;;
  *) echo "usage: $0 [--check]" >&2; exit 2 ;;
esac
[ -f "$manifest" ] || { echo "manifest not found: $manifest" >&2; exit 2; }

entries=$(grep -Ev '^[[:space:]]*(#|$)' "$manifest")
while read -r digest path source; do
  case "$digest" in *[!0-9a-f]*|'') echo "manifest digest is not hexadecimal: $digest" >&2; exit 2 ;; esac
  [ "${#digest}" -eq 64 ] || { echo "manifest digest is not SHA-256: $digest" >&2; exit 2; }
  case "$path" in /*|*..*|'') echo "manifest path is not a plain relative path: $path" >&2; exit 2 ;; esac
  case "$source" in https://*) ;; *) echo "manifest source is not https: $source" >&2; exit 2 ;; esac
done <<< "$entries"

# What the volume holds now, as "digest  path" lines the manifest's own first two columns match.
expected=$(awk '{print $1 "  " $2}' <<< "$entries")
in_volume() {
  docker run --rm -i -v "$volume:/models$1" "$helper" sh -c "$2"
}
# Proved to run first: a helper that cannot start must not read as "nothing is in the volume",
# which would download everything again.
docker run --rm "$helper" true || { echo "The helper image $helper could not be run." >&2; exit 1; }
present=$(in_volume ':ro' 'cd /models && { sha256sum -c - 2>/dev/null || true; } | sed -n "s/: OK$//p"' <<< "$expected")

missing=()
while read -r digest path source; do
  if ! grep -qxF "$path" <<< "$present"; then missing+=("$digest $path $source"); fi
done <<< "$entries"

if [ "${#missing[@]}" -eq 0 ]; then
  echo "Speech models volume $volume matches the manifest."
  exit 0
fi
if [ "$check_only" -eq 1 ]; then
  printf 'Missing or wrong in %s: %s\n' "$volume" "$(printf '%s\n' "${missing[@]}" | awk '{print $2}' | paste -sd' ' -)" >&2
  exit 1
fi

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
for entry in "${missing[@]}"; do
  read -r digest path source <<< "$entry"
  mkdir -p "$scratch/$(dirname "$path")"
  echo "Fetching $path"
  curl --fail --silent --show-error --location --retry 3 --output "$scratch/$path" "$source"
  printf '%s  %s\n' "$digest" "$path" >> "$scratch/.expected"
done
# Checked and copied in one step, in the helper, so the host needs no checksum tool and nothing
# reaches the volume unless every download matches. World-readable, owned by root: the worker
# mounts the volume read-only as an unprivileged user.
docker run --rm -v "$volume:/models" -v "$scratch:/incoming:ro" "$helper" sh -c '
  set -e
  cd /incoming
  sha256sum -c .expected >/dev/null || { echo "A download does not match its recorded digest; nothing was copied." >&2; exit 1; }
  while read -r digest file; do
    mkdir -p "/models/$(dirname "$file")"
    cp "$file" "/models/$file.partial"
    mv "/models/$file.partial" "/models/$file"
  done < .expected
  chmod -R a+rX /models'
echo "Speech models volume $volume now matches the manifest."
