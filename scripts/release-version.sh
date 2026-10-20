#!/usr/bin/env bash
# Step one of a version release: rename "## Unreleased" in CHANGELOG.md to the version and today's
# date, and set the version in every package.json. The docs note, site publish, content export and
# tag follow by hand.
#
# Usage: scripts/release-version.sh X.Y.Z
set -euo pipefail

version=${1:?Usage: scripts/release-version.sh X.Y.Z}
if ! [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "release-version: '$version' is not X.Y.Z" >&2
  exit 2
fi

cd "$(git rev-parse --show-toplevel)"

if ! grep -q '^## Unreleased$' CHANGELOG.md; then
  echo 'release-version: CHANGELOG.md has no "## Unreleased" heading' >&2
  exit 1
fi

# -i.bak works with both BSD and GNU sed.
sed -i.bak "s/^## Unreleased\$/## $version - $(date +%Y-%m-%d)/" CHANGELOG.md
rm CHANGELOG.md.bak

# Two-space indent matches only the top-level "version" key.
git ls-files '*package.json' | while read -r file; do
  sed -i.bak -E "s/^  \"version\": \"[^\"]+\"/  \"version\": \"$version\"/" "$file"
  rm "$file.bak"
done

echo "release-version: marked $version; review with git diff."
