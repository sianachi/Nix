#!/usr/bin/env bash
# Self-test for release-version.sh against a scratch repository.
set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/release-version.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

cd "$work"
git init -q
mkdir -p packages/a apps/cli/src
printf "new McpServer({ name: 'nixctl', version: '0.1.0' });\n" > apps/cli/src/mcp.ts
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
grep -q "version: '0.2.0'" apps/cli/src/mcp.ts || fail 'the MCP server identity should be bumped'
[ -z "$(find . -name '*.bak')" ] || fail 'no .bak files should be left behind'

"$script" 0.3.0 >/dev/null 2>&1 && fail 'a changelog without Unreleased should be refused'

# Without an argument the version comes from the Unreleased section's headings.
next() {
  printf '# Changelog\n\n## Unreleased\n\n%b\n## %s - 2026-01-01\n\n### Added\n\n- Old.\n' "$2" "$1" > CHANGELOG.md
  sed -i.bak -E "s/^  \"version\": \"[^\"]+\"/  \"version\": \"$1\"/" package.json && rm package.json.bak
  "$script" >/dev/null || return 1
  sed -nE 's/^  "version": "([^"]+)".*/\1/p' package.json
}
expect() { [ "$1" = "$2" ] || fail "$3: expected $2, got $1"; }

expect "$(next 0.3.1 '### Fixed\n\n- A fix.\n')" 0.3.2 'fixes only should move the patch'
expect "$(next 0.3.1 '### Security\n\n- A fix.\n')" 0.3.2 'security only should move the patch'
expect "$(next 0.3.1 '### Added\n\n- A feature.\n\n### Fixed\n\n- A fix.\n')" 0.4.0 'an addition should move the minor'
expect "$(next 0.3.1 '### Changed\n\n- **Breaking:** a rename.\n')" 0.4.0 'a breaking change before 1.0 should move the minor'
expect "$(next 1.2.3 '### Changed\n\n- **Breaking:** a rename.\n')" 2.0.0 'a breaking change after 1.0 should move the major'
(next 0.3.1 '') >/dev/null 2>&1 && fail 'an empty Unreleased section should be refused'

echo 'release-version: all tests passed.'
