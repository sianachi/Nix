#!/usr/bin/env bash
# Create a git worktree for one goal, ready to work in.
#
# One agent works one goal at a time, in its own worktree, on a goal branch
# (nix-goal-plan.md section 1.3). Doing that by hand is four commands and two of
# them are easy to forget - the symlinks that let a lane reach the standards and
# the docs, which are untracked and therefore do not come with the checkout. An
# agent that starts without them cannot read the rules it is held to, which it
# most needs to read.
#
# Usage:
#   scripts/new-goal-worktree.sh G9-item-tree            # branches from main
#   scripts/new-goal-worktree.sh G10-acl-resolver main   # explicit base
#
# Creates:
#   ../nix-lanes/<slug>        the worktree
#   goal/<slug>                the branch
#   .worktree-links paths      symlinks back to this checkout
#
# Removing one when the goal has merged:
#   git worktree remove ../nix-lanes/<slug> && git branch -d goal/<slug>
#
# The frontend needs its own node_modules per worktree; pnpm's content-addressed
# store means that costs links rather than copies, but it does need running, so
# this script offers to do it when a workspace manifest is present.
set -euo pipefail

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "usage: $0 <goal-slug> [base-ref]" >&2
  echo "   eg: $0 G9-item-tree" >&2
  exit 2
fi

slug="$1"
base="${2:-main}"

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
lanes_dir="$(cd "$repo_root/.." && pwd)/nix-lanes"
worktree="$lanes_dir/$slug"
branch="goal/$slug"

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

# The standards and the goal board are untracked by design - the rules forbid
# committing markdown, and both of them are markdown - so a fresh worktree has
# none of them. That is the failure this script mostly exists to prevent: an agent
# starting in a worktree without them cannot read the rules it is being held
# to, and will not know it is missing them.
#
# Symlinked rather than copied so there is one copy: an agent updating the goal
# board updates the board, not a private fork of it. .gitignore matches these
# without a trailing slash, so the links themselves stay untracked.
#
# Which paths get linked is a property of the checkout rather than of the
# repository - the whole point is to carry across what the repository does not
# contain, and that differs per machine. List them one to a line in
# .worktree-links (untracked, '#' comments allowed); with no such file the docs
# are linked and nothing else. A path that is not present is skipped silently,
# so a partial list costs nothing.
link_list() {
  if [ -f "$repo_root/.worktree-links" ]; then
    sed -e 's/#.*//' -e 's/[[:space:]]*$//' "$repo_root/.worktree-links"
  else
    echo docs
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
Before you commit, re-read the standards protocol. The parts most often got
wrong: stage by explicit path (never 'git add -A'), never commit markdown, use
the pre-written commit message from the goal board, and arrive green.

Do not merge to main from here. The orchestrator rebases and fast-forwards, in
dependency order, so history stays one commit per goal.
EOF
