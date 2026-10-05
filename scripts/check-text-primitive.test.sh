#!/usr/bin/env bash
# Tests for check-text-primitive.sh.
#
# Same shape as its two sibling guards' suites: a fixture corpus this script owns, never the
# repository tree, so a legitimate new `<Text>` call site elsewhere cannot turn into a spurious
# failure here and this stays a test of the matcher rather than a change detector for other
# people's work.
#
# Portable across BSD (macOS) and GNU tools; bash 3.2 compatible.
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
guard="$script_dir/check-text-primitive.sh"

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/check-text-primitive.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

passed=0
failed=0

fixture() {
  rm -rf "${work_dir:?}/tree"
  mkdir -p "$work_dir/tree"
  cat >"$work_dir/tree/$1"
}

# expect <exit code> <description> [expected substring of output ...]
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

echo "check-text-primitive.test: fixtures in $work_dir"

# --- the regression this guard exists for ------------------------------------

fixture regression.tsx <<'FIXTURE'
// workspace-sidebar.tsx's loading line before U11 migrated it. Every class is a real token,
// correctly chosen; the defect is that the paragraph owns the scale instead of <Text>.
export const Loading = () => <p className="px-3 py-2 text-sm text-muted">Loading the workspace…</p>;
FIXTURE
expect 1 "a paragraph naming a type step fails" "regression.tsx" 'variant="note"'

# --- the migrated form passes ------------------------------------------------

fixture migrated.tsx <<'FIXTURE'
export const Loading = () => (
  <Text variant="note" tone="muted" className="px-3 py-2">
    Loading the workspace…
  </Text>
);
FIXTURE
expect 0 "the same line through <Text> passes"

# --- every tag <Text> can render is covered ----------------------------------

for tag in p span h1 h2 h3 h4 h5 h6 li dt dd figcaption caption; do
  fixture "tag-${tag}.tsx" <<FIXTURE
export const A = () => <${tag} className="text-lg">Copy</${tag}>;
FIXTURE
  expect 1 "<${tag}> naming a step fails" "tag-${tag}.tsx"
done

# --- every step on the scale is covered --------------------------------------

for step in 2xs xs sm base md lg xl 2xl 3xl; do
  fixture "step-${step}.tsx" <<FIXTURE
export const A = () => <p className="text-${step}">Copy</p>;
FIXTURE
  expect 1 "text-${step} fails" "step-${step}.tsx"
done

# --- a responsive override is the same decision, made at a breakpoint --------

fixture responsive.tsx <<'FIXTURE'
export const A = () => <p className="text-base md:text-lg">Copy</p>;
FIXTURE
expect 1 "a breakpoint-prefixed step fails" "responsive.tsx"

# --- colour roles are not the type scale -------------------------------------

fixture colours.tsx <<'FIXTURE'
// text-muted, text-foreground, text-accent-text and text-left are a colour role, a colour role,
// a colour role and an alignment. None of them is a size, and flagging them would make the guard
// unusable on the first file anybody wrote.
export const A = () => <p className="text-left text-muted">Copy</p>;
export const B = () => <span className="text-foreground">Copy</span>;
export const C = () => <span className="text-accent-text">Copy</span>;
FIXTURE
expect 0 "colour roles and alignment utilities pass"

# --- the axes <Text> does not own --------------------------------------------

fixture other-axes.tsx <<'FIXTURE'
// Weight, family and tracking are deliberately out of scope: <Text> offers no weight axis,
// font-mono is a departure it will never carry, and tracking composes onto elements that can
// never be a <Text> at all.
export const A = () => <span className="font-medium">Name</span>;
export const B = () => <span className="font-mono tracking-wider">v1.2.3</span>;
FIXTURE
expect 0 "weight, family and tracking alone pass"

# --- a size class must be a whole word ---------------------------------------

fixture substring.tsx <<'FIXTURE'
// max-w-sm ends in "-sm" and max-w-md in "-md"; neither is a type step, and a matcher that
// treated the hyphen as a word boundary would fail both.
export const A = () => <p className="max-w-sm">Copy</p>;
export const B = () => <span className="max-w-md">Copy</span>;
FIXTURE
expect 0 "max-w-sm and max-w-md are not text-sm and text-md"

# --- a component is not a text tag -------------------------------------------

fixture component.tsx <<'FIXTURE'
// <Panel> starts with 'p'. The tag has to end at a space or a '>' or every capitalised component
// beginning with one of the thirteen tag names would be swept in.
export const A = () => <Panel className="text-lg">Copy</Panel>;
export const B = () => <span2 className="text-lg">Copy</span2>;
FIXTURE
expect 0 "a component whose name starts with a tag name is not that tag"

# --- comment-only lines are prose about the code -----------------------------

fixture commented.tsx <<'FIXTURE'
// This guard's own message says <p className="text-sm"> is the shape to avoid, and an example
// inside an explanation must not fail the thing it explains.
/* <span className="text-2xl"> in a block comment, likewise. */
export const A = () => <p>Copy</p>;
FIXTURE
expect 0 "an example inside a comment does not fail"

# --- the exemption marker, on the line ---------------------------------------

fixture inline-exempt.tsx <<'FIXTURE'
export const A = () => <span className="font-heading text-2xl">NX</span>; // text-primitive-exempt: wordmark
FIXTURE
expect 0 "a marker on the line exempts it"

# --- the exemption marker, in the reason above -------------------------------

fixture above-exempt.tsx <<'FIXTURE'
export const A = () => (
  <div>
    {/* text-primitive-exempt: the wordmark. Two capitals at the h2 step, opened to
        tracking-slight because a pair of caps at the heading's own tracking-tight reads as one
        glyph - which is a wordmark, and not typography the primitive should learn. */}
    <span className="font-heading text-2xl tracking-slight">NX</span>
  </div>
);
FIXTURE
expect 0 "a marker in the paragraph above exempts it"

# --- but not from arbitrarily far away ---------------------------------------

fixture distant-exempt.tsx <<'FIXTURE'
// text-primitive-exempt: this reason is nowhere near the code it claims to excuse.
export const A = () => <p>One</p>;
export const B = () => <p>Two</p>;
export const C = () => <p>Three</p>;
export const D = () => <p>Four</p>;
export const E = () => <p>Five</p>;
export const F = () => <p>Six</p>;
export const G = () => <p className="text-lg">Seven</p>;
FIXTURE
expect 1 "a marker further than the lookback window does not exempt" "distant-exempt.tsx"

# --- the whole-file escape hatch ---------------------------------------------

fixture whole-file.tsx <<'FIXTURE'
// text-primitive-exempt-file: every line here quotes another surface verbatim.
export const A = () => <p className="text-lg">Copy</p>;
export const B = () => <span className="text-xs">Copy</span>;
FIXTURE
expect 0 "a file-level marker exempts the file"

# --- test files are out of scope ---------------------------------------------

fixture_tests() {
  rm -rf "${work_dir:?}/tree"
  mkdir -p "$work_dir/tree/tests/views"
  cat >"$work_dir/tree/tests/views/board-view.test.tsx" <<'T'
// A test asserting on the class a component renders has to spell the class out.
it('sizes the column heading', () => {
  expect(container.querySelector('p')?.className).toContain('text-lg');
});
export const Fixture = () => <p className="text-lg">Copy</p>;
T
}

fixture_tests
expect 0 "src/tests is not scanned"

# --- several files, one offender ---------------------------------------------

fixture_multi() {
  rm -rf "${work_dir:?}/tree"
  mkdir -p "$work_dir/tree"
  cat >"$work_dir/tree/clean-a.tsx" <<'A'
export const A = () => <Text variant="h4">Copy</Text>;
A
  cat >"$work_dir/tree/clean-b.tsx" <<'B'
export const B = () => <Text variant="caption" as="span">Copy</Text>;
B
  cat >"$work_dir/tree/offender.tsx" <<'C'
export const C = () => <li className="text-xs text-muted">Copy</li>;
C
}

fixture_multi
expect 1 "one file out of three failing names that file" "offender.tsx"

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

printf '\ncheck-text-primitive.test: %d passed, %d failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
