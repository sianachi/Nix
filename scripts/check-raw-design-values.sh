#!/usr/bin/env bash
# Guard: design-token rule (engineering plan section 5.1).
# All colors come from the Industry design tokens in packages/design-tokens.
# A raw hex color anywhere else in frontend source is a violation.
#
# Scope:   *.ts, *.tsx, *.css under packages/ and apps/
# Skipped: packages/design-tokens (the one legitimate home for raw values),
#          node_modules, dist
# Exempt:  - a line containing a 'design-token-exempt' comment
#          - a whole file containing 'design-token-exempt-file'
#
# Exits 0 cleanly when packages/ or apps/ do not exist yet.
#
# Portable across BSD (macOS) and GNU tools: find -prune, grep -E -n with
# POSIX classes/intervals only (no \b, which BSD grep handles differently).
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

# Only scan roots that exist; zero roots is a clean pass (early repo state).
scan_roots=()
for root in packages apps; do
  [ -d "$root" ] && scan_roots+=("$root")
done
if [ "${#scan_roots[@]}" -eq 0 ]; then
  echo "check-raw-design-values: OK (no packages/ or apps/ directories yet)."
  exit 0
fi

# Word-bounded raw hex color: '#' + 3..8 hex digits, not preceded or followed
# by another word character. Implemented without \b for BSD/GNU portability:
# the run must start the line or follow a non-word char, and must not be
# followed by any word char. Backtracking inside {3,8} cannot shorten a longer
# run to force a match, because every shorter prefix is still followed by a
# word char (e.g. '#define': the hex run 'def' is followed by 'i', so it is
# correctly ignored; likewise 9+ digit hex-ish tokens never match).
hex_pattern='(^|[^0-9a-zA-Z_])#[0-9a-fA-F]{3,8}([^0-9a-zA-Z_]|$)'

violations=""
while IFS= read -r file; do
  # A heredoc over empty `find` output still yields one empty line; skip it
  # rather than letting grep report a missing file.
  [ -n "$file" ] || continue
  # Whole-file exemption marker.
  if grep -q 'design-token-exempt-file' "$file"; then
    continue
  fi
  # Report matching lines, minus per-line exemptions.
  file_hits="$(grep -nE "$hex_pattern" "$file" | grep -v 'design-token-exempt' || true)"
  if [ -n "$file_hits" ]; then
    while IFS= read -r hit; do
      violations="${violations}${file}:${hit}
"
    done <<EOF
$file_hits
EOF
  fi
done <<EOF2
$(find "${scan_roots[@]}" \
    \( -name node_modules -o -name dist -o -path 'packages/design-tokens' \) -prune \
    -o -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' \) -print)
EOF2

if [ -n "$violations" ]; then
  echo "check-raw-design-values: FAIL" >&2
  echo "Raw hex color(s) outside packages/design-tokens:" >&2
  printf '%s' "$violations" | while IFS= read -r line; do
    printf '  %s\n' "$line" >&2
  done
  echo "Rule: colors come from the Industry design tokens (packages/design-tokens)." >&2
  echo "If a raw value is genuinely required, annotate the line with a" >&2
  echo "'design-token-exempt' comment explaining why." >&2
  exit 1
fi

echo "check-raw-design-values: OK (no raw hex colors outside packages/design-tokens)."
