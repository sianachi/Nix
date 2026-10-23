#!/usr/bin/env bash
# Snapshot the published sites' content into docs/site/<name>/.
#
# One-way export: Nix is the editing source. Edit content in Nix, then rerun this
# script and commit the result; never edit these files expecting them to flow back.
#
# Each site gets two copies of its root subtree:
#   <name>.nix   the native archive, lossless (bodies, properties, views, files).
#   markdown/    one Markdown file per item, for reading and diffs. Markdown is
#                lossy (views, properties and file bodies are not represented).
#
# Restore a site from its archive into a workspace:
#   nixctl import docs/site/<name>/<name>.nix --workspace <workspace-id>
#
# Usage: scripts/export-site-content.sh [nixctl-profile]   (default: nixsites)
# NIXCTL overrides the nixctl command. Auth stays in the nixctl profile; this
# script never reads or writes tokens.
set -euo pipefail

profile=${1:-nixsites}
repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"

# Every nixctl run is one token exchange, and Core rate limits those per address,
# so wait and retry instead of failing halfway through a tree.
nixctl() {
  local attempt err
  err=$(mktemp)
  for attempt in 1 2 3 4 5 6; do
    if ${NIXCTL:-node --experimental-strip-types apps/cli/src/index.ts} --profile "$profile" --json "$@" 2>"$err"; then
      rm -f "$err"
      return 0
    fi
    grep -qE 'rate limited|could not complete CLI authentication|refused to protect the service' "$err" && [ "$attempt" -lt 6 ] || break
    echo "export-site-content: Core throttled nixctl, retrying in 60s" >&2
    sleep 60
  done
  cat "$err" >&2
  rm -f "$err"
  return 1
}

# name|workspace id|site root item id
sites=(
  'nix-docs|01a130ad-536c-7c8b-98af-f5dccb9d457a|01a130b0-044c-7d5d-a61d-0eab85259679'
)

slug() {
  local s
  s=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')
  printf '%s' "${s:-untitled}"
}

# export_tree <workspace> <item id> <title> <dir> <has children>
# Leaf items become <slug>.md; items with children become <slug>/index.md.
export_tree() {
  local ws=$1 id=$2 title=$3 dir=$4 has_children=$5 base target
  base=$(slug "$title")
  if [ "$has_children" = true ]; then
    [ -e "$dir/$base" ] && base="$base-${id: -6}"
    mkdir -p "$dir/$base"
    target="$dir/$base/index.md"
  else
    [ -e "$dir/$base.md" ] && base="$base-${id: -6}"
    target="$dir/$base.md"
  fi
  nixctl export "$id" --scope item --format md -o "$target" >/dev/null
  [ "$has_children" = true ] || return 0
  nixctl item ls --workspace "$ws" --parent "$id" \
    | jq -r '.items[] | select(.lifecycleState == "active") | [.id, .hasChildren, .title] | @tsv' \
    | while IFS=$'\t' read -r child child_has title; do
        export_tree "$ws" "$child" "$title" "$dir/$base" "$child_has"
      done
}

for entry in "${sites[@]}"; do
  IFS='|' read -r name ws root <<<"$entry"
  out="docs/site/$name"
  mkdir -p "$out"

  site_root=$(nixctl site get --item "$root" | jq -r '.rootItemId')
  [ "$site_root" = "$root" ] || { echo "export-site-content: $root is not a site root" >&2; exit 1; }
  title=$(nixctl item get "$root" | jq -r '.title')

  nixctl export "$root" --scope subtree --format nix -o "$out/$name.nix.tmp" >/dev/null
  # Each export stamps a fresh exportedAt; keep the old archive when nothing else changed.
  if [ -f "$out/$name.nix" ] && cmp -s \
    <(unzip -p "$out/$name.nix" | LC_ALL=C sed 's/"exportedAt":"[^"]*"//') \
    <(unzip -p "$out/$name.nix.tmp" | LC_ALL=C sed 's/"exportedAt":"[^"]*"//'); then
    rm "$out/$name.nix.tmp"
  else
    mv "$out/$name.nix.tmp" "$out/$name.nix"
  fi

  # Build into a scratch dir and swap, so stale files go and a failure keeps the old tree.
  # markdown/api is the public HTTP API guide, generated from the OpenAPI
  # contract and committed beside the snapshot. The workspace does not author
  # it, so an export that has no API section keeps the committed tree.
  api_keep=""
  if [ -d "$out/markdown/api" ]; then
    api_keep=$(mktemp -d)
    cp -a "$out/markdown/api" "$api_keep/api"
  fi
  tmp=$(mktemp -d "$out/.markdown.XXXXXX")
  trap 'rm -rf "$tmp" ${api_keep:+"$api_keep"}' EXIT
  export_tree "$ws" "$root" "$title" "$tmp" true
  rm -rf "$out/markdown"
  mv "$tmp/$(slug "$title")" "$out/markdown"
  if [ -n "$api_keep" ] && [ ! -e "$out/markdown/api" ]; then
    mv "$api_keep/api" "$out/markdown/api"
  fi
  rm -rf "$tmp" ${api_keep:+"$api_keep"}
  trap - EXIT

  printf '%-10s %s (%s), %s Markdown files (%s)\n' "$name" "$out/$name.nix" \
    "$(du -h "$out/$name.nix" | cut -f1 | tr -d ' ')" \
    "$(find "$out/markdown" -name '*.md' | wc -l | tr -d ' ')" \
    "$(du -sh "$out/markdown" | cut -f1 | tr -d ' ')"
done
