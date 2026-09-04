#!/usr/bin/env bash
# Create an isolated git worktree for one focused feature, ready to work in.
#
# Use this before editing whenever the current checkout has unrelated changes or
# the feature needs more than one commit. It keeps staging and validation scoped.
#
# Usage:
#   scripts/new-goal-worktree.sh validation-workflow       # branches from main
#   scripts/new-goal-worktree.sh auth-hardening main       # explicit base
#
# Creates:
#   ../nix-lanes/<slug>        the worktree
#   feature/<slug>             the branch
#   .worktree-links paths      symlinks back to this checkout
#
# Removing one when the goal has merged:
#   git worktree remove ../nix-lanes/<slug> && git branch -d feature/<slug>
#
# The frontend needs its own node_modules per worktree; pnpm's content-addressed
# store means that costs links rather than copies, but it does need running, so
# this script offers to do it when a workspace manifest is present.
set -euo pipefail

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "usage: $0 <feature-slug> [base-ref]" >&2
  echo "   eg: $0 validation-workflow" >&2
  exit 2
fi

slug="$1"
base="${2:-main}"

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
lanes_dir="$(cd "$repo_root/.." && pwd)/nix-lanes"
worktree="$lanes_dir/$slug"
branch="feature/$slug"

cd "$repo_root"

if git show-ref --verify --quiet "refs/heads/$branch"; then
  echo "error: branch '$branch' already exists" >&2
  echo "  work on it:   cd $worktree" >&2
  echo "  or remove it: git worktree remove $worktree && git branch -D $branch" >&2
  exit 1
fi

if [ -e "$worktree" ]; then
  echo "error: '$worktree' already exists" >&2
  exit 1
fi

if ! git rev-parse --verify --quiet "$base" >/dev/null; then
  echo "error: base ref '$base' does not exist" >&2
  exit 1
fi

mkdir -p "$lanes_dir"

echo "worktree: branching '$branch' from '$base'"
git worktree add -b "$branch" "$worktree" "$base" >/dev/null

# Optional local-only paths can be linked into a worktree through
# .worktree-links (one path per line, '#' comments allowed). Tracked standards
# already arrive with the checkout; links are only for machine-specific material.
link_list() {
  if [ -f "$repo_root/.worktree-links" ]; then
    sed -e 's/#.*//' -e 's/[[:space:]]*$//' "$repo_root/.worktree-links"
  fi
}

link_list | while IFS= read -r link; do
  [ -n "$link" ] || continue
  if [ -e "$repo_root/$link" ] && [ ! -e "$worktree/$link" ]; then
    ln -s "$repo_root/$link" "$worktree/$link"
    echo "worktree: linked $link"
  fi
done

echo
echo "worktree ready: $worktree"
echo "  branch : $branch (from $base)"
echo

if [ -f "$worktree/pnpm-workspace.yaml" ]; then
  echo "next: install frontend dependencies (only needed for a frontend goal)"
  echo "  cd $worktree && pnpm install"
fi

cat <<EOF
Before you commit, run scripts/validate-changed.sh --working-tree. Stage by
explicit path (never 'git add -A') and arrive green.

Do not merge to main from here. The orchestrator rebases and fast-forwards, in
dependency order, so history stays one commit per goal.
EOF
