#!/usr/bin/env bash
# List old release checkouts (~/nix-release-*) and pre-release backups (~/nix-backups/pre-*),
# and delete them only with --apply. Dry run by default.
#
# Keeps: the running release (tag of the running nix-api image), the release before it,
# any release newer than it, any checkout a running container was created from, and every
# backup at least as new as the previous release checkout or naming the current, previous
# or a newer release. Order is directory modification time. Deletes nothing when the
# running release cannot be matched to a checkout. Never touches Docker volumes,
# ~/nix-production, symbolic links or anything outside those two patterns. Nightly backups
# (~/nix-backups/nightly-*) belong to nightly.sh, which applies their retention; never add them here.
set -euo pipefail

apply=0
case "${1:-}" in
  '') ;;
  --apply) apply=1 ;;
  *) echo 'usage: prune.sh [--apply]' >&2; exit 2 ;;
esac
home=${NIX_PRUNE_HOME:-$HOME}
project=${NIX_COMPOSE_PROJECT:-nix}

mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; }
# Release IDs are commit SHAs of any length >= 7; the image tag may be the full SHA.
same_release() {
  [ "${#1}" -ge 7 ] && [ "${#2}" -ge 7 ] || return 1
  case "$1" in "$2"*) return 0 ;; esac
  case "$2" in "$1"*) return 0 ;; esac
  return 1
}

image=$(docker ps --filter "label=com.docker.compose.project=$project" \
  --filter label=com.docker.compose.service=nix-api --format '{{.Image}}' | sed -n 1p)
tag=${image##*:}
if [ -z "$image" ] || [ "$tag" = "$image" ] || [ -z "$tag" ]; then
  echo "prune: no running nix-api container with a tagged image in project '$project'; nothing deleted." >&2
  exit 1
fi
# Paths running containers were created from; their checkouts stay even when old.
in_use=$(docker ps -a --filter "label=com.docker.compose.project=$project" \
  --format '{{.Label "com.docker.compose.project.working_dir"}},{{.Label "com.docker.compose.project.config_files"}}' | tr ',' '\n' | sed '/^$/d' | sort -u)

used() {
  local path
  while IFS= read -r path; do
    case "$path" in "$1"|"$1"/*) return 0 ;; esac
  done <<< "$in_use"
  return 1
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
: > "$work/releases"
for d in "$home"/nix-release-*; do
  [ -d "$d" ] && [ ! -L "$d" ] || continue
  echo "$(mtime "$d") $d" >> "$work/releases"
done
sort -rn -o "$work/releases" "$work/releases"

current_line=''
while IFS=' ' read -r _ d; do
  if same_release "${d##*/nix-release-}" "$tag"; then current_line=$d; break; fi
done < "$work/releases"
if [ -z "$current_line" ]; then
  echo "prune: running release $tag has no checkout under $home/nix-release-*; nothing deleted." >&2
  exit 1
fi

# Newest first: everything before the current release is newer; the next one is the previous.
kept_ids=''
threshold=''
state=newer
plan=()
while IFS=' ' read -r when d; do
  id=${d##*/nix-release-}
  phase=$state
  case "$state" in
    newer)
      if [ "$d" = "$current_line" ]; then reason='current release'; state=previous
      else reason='newer than the current release'; fi ;;
    previous) reason='previous release'; threshold=$when; state=older ;;
    older)
      if used "$d"; then reason='used by a running container'; else reason=''; fi ;;
  esac
  if [ -n "$reason" ]; then
    [ "$phase" = older ] || kept_ids="$kept_ids $id"
    plan+=("keep|$d|$reason")
  else
    plan+=("delete|$d|older than the previous release")
  fi
done < "$work/releases"
[ -n "$threshold" ] || threshold=0 # no previous release: keep every backup

for b in "$home"/nix-backups/pre-*; do
  [ -d "$b" ] && [ ! -L "$b" ] || continue
  name=${b##*/}
  reason=''
  if [ "$threshold" -eq 0 ] || [ "$(mtime "$b")" -ge "$threshold" ]; then
    reason='not older than the previous release'
  else
    for id in $kept_ids; do
      case "$name" in *"${id:0:7}"*) reason="backup of kept release $id"; break ;; esac
    done
  fi
  if [ -n "$reason" ]; then plan+=("keep|$b|$reason"); else plan+=("delete|$b|older than the previous release"); fi
done

deleted=0
for entry in ${plan[@]+"${plan[@]}"}; do
  action=${entry%%|*}; rest=${entry#*|}; path=${rest%%|*}; reason=${rest#*|}
  if [ "$action" = keep ]; then printf 'keep    %s (%s)\n' "$path" "$reason"; continue; fi
  case "$path" in
    "$home"/nix-release-*|"$home"/nix-backups/pre-*) ;;
    *) echo "prune: refusing unexpected path $path" >&2; exit 1 ;;
  esac
  case "$path" in "$home/nix-production"|"$home/nix-production"/*) continue ;; esac
  if [ "$apply" = 1 ]; then
    rm -rf -- "$path"; printf 'deleted %s\n' "$path"
  else
    printf 'delete  %s (%s)\n' "$path" "$reason"
  fi
  deleted=$((deleted + 1))
done
if [ "$apply" = 1 ]; then
  echo "prune: deleted $deleted path(s). Docker volumes were not touched."
else
  echo "prune: dry run; $deleted path(s) would be deleted. Re-run with --apply to delete them."
fi
