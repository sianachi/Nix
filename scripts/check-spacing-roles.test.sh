#!/usr/bin/env bash
# Tests for check-spacing-roles.sh.
#
# Same shape as check-raw-design-values.test.sh: a fixture corpus this script owns, never the
# repository tree, so a legitimate new use of p-3 elsewhere cannot turn into a spurious failure
# here and this suite stays a test of the matcher rather than a change detector for other people's
# work.
#
# Portable across BSD (macOS) and GNU tools; bash 3.2 compatible.
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
guard="$script_dir/check-spacing-roles.sh"

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/check-spacing-roles.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

passed=0
failed=0

fixture() {
  rm -rf "${work_dir:?}/tree"
  mkdir -p "$work_dir/tree"
  cat >"$work_dir/tree/$1"
}

# expect <exit code> <description> [expected substring of stderr ...]
expect() {
  local want_code="$1"
  local description="$2"
  shift 2

  local output
  local got_code=0
  output="$("$guard" "$work_dir/tree" 2>&1)" || got_code=$?

  local problem=""
  if [ "$got_code" -ne "$want_code" ]; then
    problem="exit $got_code, wanted $want_code"
  else
    local needle
    for needle in "$@"; do
      case "$output" in
        *"$needle"*) ;;
        *) problem="output missing '$needle'" ;;
      esac
    done
  fi

  if [ -n "$problem" ]; then
    failed=$((failed + 1))
    printf '  FAIL  %s\n' "$description" >&2
    printf '        %s\n' "$problem" >&2
    printf '%s\n' "$output" | while IFS= read -r line; do
      printf '        | %s\n' "$line" >&2
    done
  else
    passed=$((passed + 1))
    printf '  ok    %s\n' "$description"
  fi
}

role_heading='bordered group -> p-3'

echo "check-spacing-roles.test: fixtures in $work_dir"

# --- the shape at the established step passes -------------------------------

fixture correct.tsx <<'FIXTURE'
export const Column = () => (
  <section className="flex w-80 shrink-0 flex-col gap-2 border border-divider p-3" />
);
FIXTURE
expect 0 "the bordered group at p-3 passes"

# --- the exact regression this guard exists for ------------------------------

fixture regression.tsx <<'FIXTURE'
// This is board-view.tsx's column panel before U13 corrected it: the same bordered, gap-2,
// flex-col shape as five other panels elsewhere in the tree, padded one step tighter than all of
// them.
export const Column = () => (
  <section className="flex w-80 shrink-0 flex-col gap-2 border border-divider p-2" />
);
FIXTURE
expect 1 "the shape at p-2 fails" "$role_heading"

fixture regression-p4.tsx <<'FIXTURE'
export const Column = () => (
  <section className="flex flex-col gap-2 border border-divider p-4" />
);
FIXTURE
expect 1 "the shape at p-4 fails the same way" "$role_heading"

fixture regression-trailing-comment.tsx <<'FIXTURE'
export const Column = () => (
  <section className="flex flex-col gap-2 border border-divider p-2" /> // TODO: was p-3
);
FIXTURE
expect 1 "the required step does not count when it only appears in a trailing comment" "$role_heading"

# --- near-misses: the shape is incomplete, so the rule does not apply --------

fixture missing-border.tsx <<'FIXTURE'
// No border-divider at all - a plain stacked group, not the bordered panel role.
export const Stack = () => <div className="flex flex-col gap-2 p-2" />;
FIXTURE
expect 0 "flex-col gap-2 without border-divider is not the role"

fixture missing-gap.tsx <<'FIXTURE'
// Bordered, but not gap-2 - a different grouping, not this role.
export const Row = () => <div className="flex flex-col gap-4 border border-divider p-2" />;
FIXTURE
expect 0 "a bordered flex-col group at a different gap is not the role"

fixture missing-flex-col.tsx <<'FIXTURE'
// Bordered and gap-2, but not column-stacked - a row, not this role.
export const Row = () => <div className="flex items-center gap-2 border border-divider p-2" />;
FIXTURE
expect 0 "a bordered row at gap-2 is not the role (no flex-col)"

fixture near-miss-gap-3.tsx <<'FIXTURE'
// This line is not the role's shape at all (gap-3, not gap-2), so it says nothing about the token
// boundary on its own - see 'boundary-proof' below for the fixture that actually exercises it.
export const Row = () => <div className="flex flex-col gap-3 border border-divider p-2" />;
FIXTURE
expect 0 "a bordered flex-col group at gap-3 (not gap-2) is not the role"

fixture boundary-proof.tsx <<'FIXTURE'
// This line IS the role's shape (flex-col, gap-2, border-divider are all present) and pads at
// p-2, which is the violation. The only text resembling 'p-3' anywhere on the line is the tail of
// 'sm:gap-3' - if the token boundary let a hyphen count as a separator, 'p-3' would be read out of
// '...ga-p-3' and this would wrongly pass. It must still fail.
export const Row = () => (
  <div className="flex flex-col gap-2 border border-divider p-2 sm:gap-3" />
);
FIXTURE
expect 1 "'p-3' inside 'sm:gap-3' does not satisfy the role's required step" "$role_heading"

# --- escape hatches ----------------------------------------------------------

fixture per-line-marker.tsx <<'FIXTURE'
export const Column = () => (
  <section className="flex flex-col gap-2 border border-divider p-2" /* spacing-role-exempt: fixture */ />
);
FIXTURE
expect 0 "the per-line marker suppresses the rule on that line"

fixture whole-file-marker.tsx <<'FIXTURE'
/* spacing-role-exempt-file: fixture for the whole-file escape hatch. */
export const Column = () => (
  <section className="flex flex-col gap-2 border border-divider p-2" />
);
FIXTURE
expect 0 "the whole-file marker suppresses the rule across the file"

fixture comment-prose.tsx <<'FIXTURE'
// Prose describing the violating shape is not the shape itself:
// flex flex-col gap-2 border border-divider p-2
export const Column = () => (
  <section className="flex flex-col gap-2 border border-divider p-3" />
);
FIXTURE
expect 0 "a comment quoting the violating shape passes"

# --- multiple files, only one wrong ------------------------------------------

fixture_multi() {
  rm -rf "${work_dir:?}/tree"
  mkdir -p "$work_dir/tree"
  cat >"$work_dir/tree/agrees-a.tsx" <<'A'
export const A = () => <div className="flex flex-col gap-2 border border-divider p-3" />;
A
  cat >"$work_dir/tree/agrees-b.tsx" <<'B'
export const B = () => <div className="flex flex-col gap-2 border border-divider p-3" />;
B
  cat >"$work_dir/tree/disagrees.tsx" <<'C'
export const C = () => <div className="flex flex-col gap-2 border border-divider p-2" />;
C
}

fixture_multi
expect 1 "one file out of three disagreeing still fails, naming the role" "$role_heading" "disagrees.tsx"

# --- argument handling -------------------------------------------------------

missing_code=0
"$guard" "$work_dir/not-a-directory" >/dev/null 2>&1 || missing_code=$?
if [ "$missing_code" -eq 2 ]; then
  passed=$((passed + 1))
  echo "  ok    a non-existent explicit root is an error, not a silent pass"
else
  failed=$((failed + 1))
  echo "  FAIL  a non-existent explicit root is an error, not a silent pass" >&2
  echo "        exit $missing_code, wanted 2" >&2
fi

# --- summary -----------------------------------------------------------------

printf '\ncheck-spacing-roles.test: %d passed, %d failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
