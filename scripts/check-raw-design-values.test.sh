#!/usr/bin/env bash
# Tests for check-raw-design-values.sh.
#
# The guard is verified against a fixture corpus this script owns, never
# against the repository tree: the tree's violation count moves with every
# design change, so asserting on it would make this suite a change detector
# for other people's work rather than a test of the matcher. Fixtures also
# let a near-miss be stated as a near-miss - the interesting half of a guard
# is what it declines to flag.
#
# Each case writes one file into a temp directory, points the guard at that
# directory, and asserts on exit code and (for the failures) which rule
# heading came back.
#
# Portable across BSD (macOS) and GNU tools; bash 3.2 compatible.
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
guard="$script_dir/check-raw-design-values.sh"

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/check-raw-design-values.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

passed=0
failed=0

# Reset the fixture directory and write one file into it. Content arrives on
# stdin so the cases below read as the source they are checking.
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

hex_heading='Raw hex color(s)'
length_heading='Raw px/rem length(s)'
tracking_heading='Arbitrary letter-spacing'
style_heading='Inline style attribute(s)'

echo "check-raw-design-values.test: fixtures in $work_dir"

# --- a clean file passes -----------------------------------------------------

fixture clean.tsx <<'FIXTURE'
export function Card() {
  return (
    <div className="rounded-md bg-surface px-3 py-2 text-muted shadow-sm">
      <span className="font-heading text-xs uppercase tracking-wide">Card</span>
    </div>
  );
}
FIXTURE
expect 0 "a file built from tokens passes"

# --- rule 1: raw hex ---------------------------------------------------------

fixture hex.tsx <<'FIXTURE'
const brand = '#4a7c9b';
FIXTURE
expect 1 "a raw hex color fails" "$hex_heading"

fixture hex-near-miss.ts <<'FIXTURE'
// '#define' is not a color: the hex run 'def' is followed by a word char.
const directive = '#define';
// A 9-digit run is too long to be a color.
const digest = '#0123456789';
FIXTURE
expect 0 "hex-shaped words that are not colors pass"

# --- rule 2: raw px/rem lengths ---------------------------------------------

fixture length-px.tsx <<'FIXTURE'
export const Row = () => <div className="px-[14px]" />;
FIXTURE
expect 1 "an arbitrary px length fails" "$length_heading"

fixture length-rem.tsx <<'FIXTURE'
export const Row = () => <div className="min-w-[14rem]" />;
FIXTURE
expect 1 "an arbitrary rem length fails" "$length_heading"

fixture length-negative.tsx <<'FIXTURE'
export const Row = () => <div className="focus-visible:outline-offset-[-2px]" />;
FIXTURE
expect 1 "a negative arbitrary length fails" "$length_heading"

fixture length-embedded.tsx <<'FIXTURE'
export const Grid = () => (
  <div className="md:grid-cols-[400px_300px]">
    <aside className="w-[min(560px,calc(100vw-var(--spacing)*8))]" />
  </div>
);
FIXTURE
expect 1 "a length inside a longer arbitrary value fails" "$length_heading"

fixture length-near-miss.ts <<'FIXTURE'
// A regex character class, not a Tailwind arbitrary value. No unit follows a
// digit, so the guard must ignore it.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// A unit glued to a longer word is not a unit.
const words = ['16remainder', '12pxl', 'display-[blockpxish]'];
// Viewport- and content-relative units have no token scale to come from.
const relative = 'max-h-[80vh] pt-[12vh] max-w-[16ch] basis-[50%]';
// Derived from the spacing token, therefore legitimate.
const derived = 'px-[calc(var(--spacing)*3.6)] gap-[var(--control-lg)]';
// An arbitrary value that is not a length at all.
const image = "bg-[url(https://example.test/a-1.5/b.png)]";
FIXTURE
expect 0 "near-misses of the length rule pass"

# --- rule 3: arbitrary letter-spacing ---------------------------------------

fixture tracking.tsx <<'FIXTURE'
export const Label = () => <span className="uppercase tracking-[0.08em]" />;
FIXTURE
expect 1 "arbitrary letter-spacing fails" "$tracking_heading"

fixture tracking-variant.tsx <<'FIXTURE'
export const Label = () => <span className="md:tracking-[0.1em]" />;
FIXTURE
expect 1 "arbitrary letter-spacing behind a variant fails" "$tracking_heading"

fixture tracking-near-miss.tsx <<'FIXTURE'
// The named scale is the whole point; these are the correct spellings.
export const Label = () => <span className="tracking-wide tracking-widest" />;
// A longer word that merely ends in 'tracking' is not the utility.
export const note = 'backtracking-[0.1em] is not a class name';
FIXTURE
expect 0 "named tracking utilities and lookalike identifiers pass"

# --- rule 4: inline style attributes ----------------------------------------

fixture inline-style.tsx <<'FIXTURE'
export const Row = ({ depth }: { depth: number }) => (
  <div style={{ paddingLeft: `${String(depth * 12)}px` }} />
);
FIXTURE
expect 1 "an inline style attribute fails" "$style_heading"

fixture inline-style-spaced.tsx <<'FIXTURE'
export const Row = () => <div style = {{ top: 0 }} />;
FIXTURE
expect 1 "an inline style attribute with spaces around '=' fails" "$style_heading"

fixture inline-style-near-miss.tsx <<'FIXTURE'
// A single-brace expression is a value, not an inline style literal, and a
// prop merely named 'style' is not the DOM attribute pattern the rule bans.
export const Row = () => <Chart styleName={theme} data={{ x: 1, y: 2 }} />;
FIXTURE
expect 0 "single-brace props and nested object props pass"

# The rule is scoped to .tsx: JSX cannot appear in a .ts file, so a match
# there would only ever be prose about the rule.
fixture inline-style-in-ts.ts <<'FIXTURE'
export const forbidden = 'style={{ color: red }}';
FIXTURE
expect 0 "the inline-style rule does not fire outside .tsx"

# --- escape hatches ----------------------------------------------------------

fixture per-line-marker.tsx <<'FIXTURE'
export const Row = () => (
  <div
    className="px-[14px] tracking-[0.08em]" /* design-token-exempt: fixture */
    style={{ top: 0 }} /* design-token-exempt: fixture */
  >
    {'#4a7c9b' /* design-token-exempt: fixture */}
  </div>
);
FIXTURE
expect 0 "the per-line marker suppresses every rule on that line"

fixture per-line-marker-partial.tsx <<'FIXTURE'
export const Row = () => (
  <div
    className="px-[14px]" /* design-token-exempt: fixture */
    data-alt="size-[26px]"
  />
);
FIXTURE
expect 1 "the per-line marker suppresses only its own line" "$length_heading"

fixture comment-prose.tsx <<'FIXTURE'
// Prose about the rule is not a breach of it: a leftover `text-[13px]` or a
// stray tracking-[0.08em] is exactly what this comment exists to warn about,
// and an inline style={{ ... }} likewise.
/* A block comment opening on this line says the same, in #4a7c9b. */
export const Row = () => <div className="px-3 tracking-wide" />;
FIXTURE
expect 0 "a comment quoting a banned spelling passes"

fixture comment-trailing.tsx <<'FIXTURE'
export const Row = () => <div className="px-[14px]" />; // still ships
FIXTURE
expect 1 "a trailing comment does not excuse the code on its line" "$length_heading"

fixture whole-file-marker.tsx <<'FIXTURE'
/* design-token-exempt-file: fixture for the whole-file escape hatch. */
export const Row = () => (
  <div className="px-[14px] tracking-[0.08em]" style={{ top: 0 }}>
    {'#4a7c9b'}
  </div>
);
FIXTURE
expect 0 "the whole-file marker suppresses every rule in the file"

# --- all four rules at once --------------------------------------------------

fixture everything.tsx <<'FIXTURE'
export const Row = () => (
  <div className="size-[26px] tracking-[0.1em]" style={{ color: '#4a7c9b' }} />
);
FIXTURE
expect 1 "a file breaking all four rules reports all four" \
  "$hex_heading" "$length_heading" "$tracking_heading" "$style_heading"

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

printf '\ncheck-raw-design-values.test: %d passed, %d failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
