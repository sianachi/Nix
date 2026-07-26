#!/usr/bin/env bash
# Guard: backend memory rule 7 (engineering plan section 3.1).
# `byte[]` allocations are a last resort, allowed only when an external API
# forces one, and every such allocation must carry an inline justification
# marker on the same line:  // byte[]: <reason>
#
# This script fails (exit 1) and lists file:line for every `new byte[`
# occurrence under backend/src whose line lacks the marker.
# Test code under backend/tests is exempt by scope.
#
# Portable across BSD (macOS) and GNU grep: only -r, -n, --include, and
# basic regular expressions are used.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

src_dir="backend/src"

if [ ! -d "$src_dir" ]; then
  echo "check-byte-array-markers: $src_dir not found; nothing to check." >&2
  exit 0
fi

# grep exits 1 when nothing matches; that is the good case, so soak it up.
matches="$(grep -rn --include='*.cs' 'new byte\[' "$src_dir" || true)"

violations=""
if [ -n "$matches" ]; then
  # Keep only matched lines that do NOT carry the justification marker.
  violations="$(printf '%s\n' "$matches" | grep -v '// byte\[\]:' || true)"
fi

if [ -n "$violations" ]; then
  echo "check-byte-array-markers: FAIL" >&2
  echo "Raw 'new byte[' allocation(s) without a '// byte[]: <reason>' marker:" >&2
  printf '%s\n' "$violations" | while IFS= read -r line; do
    # file:line:content -> report file:line plus the offending code.
    printf '  %s\n' "$line" >&2
  done
  echo "Rule: byte[] only when an external API forces it, annotated on the same line" >&2
  echo "with '// byte[]: <reason>' (engineering plan section 3.1)." >&2
  exit 1
fi

echo "check-byte-array-markers: OK (all 'new byte[' allocations under $src_dir carry a marker)."
