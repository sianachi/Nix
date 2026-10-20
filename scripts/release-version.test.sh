#!/usr/bin/env bash
# Self-test for release-version.sh against a scratch repository.
set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/release-version.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

cd "$work"
git init -q
mkdir -p packages/a
printf '# Changelog\n\n## Unreleased\n\n- New thing.\n\n## 0.1.0 - 2026-01-01\n' > CHANGELOG.md
printf '{\n  "name": "root",\n  "version": "0.1.0"\n}\n' > package.json
printf '{\n  "version": "0.1.0",\n  "dependencies": {\n    "x": {\n      "version": "9.9.9"\n    }\n  }\n}\n' > packages/a/package.json
git add .

fail() { echo "FAIL: $1" >&2; exit 1; }

"$script" 1.2 >/dev/null 2>&1 && fail 'a version that is not X.Y.Z should be refused'

"$script" 0.2.0 >/dev/null
grep -qx "## 0.2.0 - $(date +%Y-%m-%d)" CHANGELOG.md || fail 'Unreleased heading should be renamed'
grep -qx '## 0.1.0 - 2026-01-01' CHANGELOG.md || fail 'older headings should be untouched'
grep -qx '  "version": "0.2.0"' package.json || fail 'root package.json should be bumped'
grep -qx '  "version": "0.2.0",' packages/a/package.json || fail 'workspace package.json should be bumped'
grep -q '"version": "9.9.9"' packages/a/package.json || fail 'nested version keys should be untouched'
[ -z "$(find . -name '*.bak')" ] || fail 'no .bak files should be left behind'

"$script" 0.3.0 >/dev/null 2>&1 && fail 'a changelog without Unreleased should be refused'

echo 'release-version: all tests passed.'
