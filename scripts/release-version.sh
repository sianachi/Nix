#!/usr/bin/env bash
# Step one of a version release: rename "## Unreleased" in CHANGELOG.md to the version and today's
# date, and set the version in every package.json and the MCP server identity. The docs note, site
# publish, content export and tag follow by hand.
#
# Without an argument the version comes from the Unreleased section, by the rule in
# docs/release/release-process.md: a "**Breaking:**" entry moves the major number (the minor one
# while 0.x), an Added, Changed, Deprecated or Removed section moves the minor one, and Fixed or
# Security alone moves the patch.
#
# Usage: scripts/release-version.sh [X.Y.Z]
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if ! grep -q '^## Unreleased$' CHANGELOG.md; then
  echo 'release-version: CHANGELOG.md has no "## Unreleased" heading' >&2
  exit 1
fi

version=${1:-}
if [ -z "$version" ]; then
  unreleased=$(sed -n '/^## Unreleased$/,/^## [0-9]/p' CHANGELOG.md)
  current=$(sed -nE 's/^  "version": "([0-9]+\.[0-9]+\.[0-9]+)".*/\1/p' package.json)
  IFS=. read -r major minor patch <<<"$current"
  if grep -q '\*\*Breaking:\*\*' <<<"$unreleased" && [ "$major" -gt 0 ]; then
    version="$((major + 1)).0.0"
  elif grep -qE '\*\*Breaking:\*\*|^### (Added|Changed|Deprecated|Removed)$' <<<"$unreleased"; then
    version="$major.$((minor + 1)).0"
  elif grep -qE '^### (Fixed|Security)$' <<<"$unreleased"; then
    version="$major.$minor.$((patch + 1))"
  else
    echo 'release-version: the Unreleased section has no entries' >&2
    exit 1
  fi
fi
if ! [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "release-version: '$version' is not X.Y.Z" >&2
  exit 2
fi

# -i.bak works with both BSD and GNU sed.
sed -i.bak "s/^## Unreleased\$/## $version - $(date +%Y-%m-%d)/" CHANGELOG.md
rm CHANGELOG.md.bak

# Two-space indent matches only the top-level "version" key.
git ls-files '*package.json' | while read -r file; do
  sed -i.bak -E "s/^  \"version\": \"[^\"]+\"/  \"version\": \"$version\"/" "$file"
  rm "$file.bak"
done

sed -i.bak -E "s/(name: 'nixctl', version: ')[^']+'/\1$version'/" apps/cli/src/mcp.ts
rm apps/cli/src/mcp.ts.bak

echo "release-version: marked $version; review with git diff."
