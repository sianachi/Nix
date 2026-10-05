#!/usr/bin/env bash
# Tests for check-frontend-layering.sh.
#
# Same shape as check-spacing-roles.test.sh: a fixture corpus this script owns, never the
# repository tree, so a legitimate new import elsewhere cannot turn into a spurious failure here
# and this suite stays a test of the matcher rather than a change detector for other people's work.
#
# Portable across BSD (macOS) and GNU tools; bash 3.2 compatible.
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
guard="$script_dir/check-frontend-layering.sh"

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/check-frontend-layering.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

passed=0
failed=0

# A tree with every tier present and nothing in it that violates a rule. Each case below starts
# from this and adds exactly one file, so a failure names the rule rather than the fixture.
reset_tree() {
  rm -rf "${work_dir:?}/src"
  mkdir -p "$work_dir/src/layout" "$work_dir/src/a11y" "$work_dir/src/lib" \
    "$work_dir/src/shell" "$work_dir/src/items" "$work_dir/src/tests"
  printf "export const paneClip = 'min-h-0';\n" >"$work_dir/src/layout/regions.ts"
  printf "export function announce(): void {}\n" >"$work_dir/src/a11y/announcer.ts"
  printf "export function browserStorage(): void {}\n" >"$work_dir/src/lib/browser-storage.ts"
  printf "export interface ShellContext { readonly id: string }\n" >"$work_dir/src/shell/shell-context.ts"
  printf "export function Sidebar(): null { return null; }\n" >"$work_dir/src/items/workspace-sidebar.tsx"
}

# add <relative path> ; body on stdin
add() {
  mkdir -p "$(dirname "$work_dir/src/$1")"
  cat >"$work_dir/src/$1"
}

# expect <exit code> <description> [expected substring of output ...]
expect() {
  want_code="$1"
  description="$2"
  shift 2

  output=""
  got_code=0
  output="$("$guard" "$work_dir/src" 2>&1)" || got_code=$?

  problem=""
  if [ "$got_code" -ne "$want_code" ]; then
    problem="exit $got_code, wanted $want_code"
  else
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

echo "check-frontend-layering.test: fixtures in $work_dir"

# --- the clean tree ----------------------------------------------------------

reset_tree
expect 0 "a tree with every tier and no violation passes"

# --- R1: layout/ is a leaf that may reach lib/ -------------------------------

reset_tree
add layout/use-sidebar.ts <<'FIXTURE'
import { browserStorage } from '../lib/browser-storage';
export const width = browserStorage;
FIXTURE
expect 0 "layout/ may import lib/"

reset_tree
add layout/use-sidebar.ts <<'FIXTURE'
import { paneClip } from './regions';
export const width = paneClip;
FIXTURE
expect 0 "layout/ may import its own folder"

reset_tree
add layout/use-sidebar.ts <<'FIXTURE'
import { announce } from '../a11y/announcer';
export const width = announce;
FIXTURE
expect 1 "layout/ importing a11y/ fails" "layout/ imports something other than lib/" "use-sidebar.ts"

reset_tree
add layout/use-sidebar.ts <<'FIXTURE'
import { Sidebar } from '../items/workspace-sidebar';
export const width = Sidebar;
FIXTURE
expect 1 "layout/ importing a feature fails" "layout/ imports something other than lib/"

reset_tree
add layout/barrel.ts <<'FIXTURE'
export { Sidebar } from '../items/workspace-sidebar';
FIXTURE
expect 1 "a re-export out of layout/ is an edge like any other" "layout/ imports something other than lib/"

reset_tree
add layout/lazy.ts <<'FIXTURE'
export const load = async () => import('../items/workspace-sidebar');
FIXTURE
expect 1 "a dynamic import out of layout/ is an edge like any other" "layout/ imports something other than lib/"

reset_tree
add layout/documented.ts <<'FIXTURE'
/**
 * This folder must never do the following, which is why it is written here:
 *   import { Sidebar } from '../items/workspace-sidebar';
 */
// import { announce } from '../a11y/announcer';
export const nothing = 0;
FIXTURE
expect 0 "an import quoted in a comment is not a finding"

# --- R2 and R3: the absolute leaves ------------------------------------------

reset_tree
add a11y/live-region.ts <<'FIXTURE'
import { browserStorage } from '../lib/browser-storage';
export const store = browserStorage;
FIXTURE
expect 1 "a11y/ is tighter than layout/ - even lib/ is out of reach" "a11y/ imports from the application"

reset_tree
add lib/helper.ts <<'FIXTURE'
import { paneClip } from '../layout/regions';
export const clip = paneClip;
FIXTURE
expect 1 "lib/ importing the application fails" "lib/ imports from the application"

# --- R4: the shell is not imported for a value -------------------------------

reset_tree
add items/tree.tsx <<'FIXTURE'
import type { ShellContext } from '../shell/shell-context';
export const id = (c: ShellContext) => c.id;
FIXTURE
expect 0 "a feature may import a type from shell/"

reset_tree
add items/tree.tsx <<'FIXTURE'
import { type ShellContext } from '../shell/shell-context';
export const id = (c: ShellContext) => c.id;
FIXTURE
expect 0 "the inline type-import spelling is allowed too"

reset_tree
add items/tree.tsx <<'FIXTURE'
import { AppShell } from '../shell/app-shell';
export const shell = AppShell;
FIXTURE
expect 1 "a feature importing a value from shell/ fails" "imports shell/ for a value"

reset_tree
add shell/nav-rail.tsx <<'FIXTURE'
import { AppShell } from './app-shell';
export const rail = AppShell;
FIXTURE
expect 0 "shell/ may import itself for a value"

# --- R5: the dissolved folder stays dissolved --------------------------------

reset_tree
mkdir -p "$work_dir/src/app"
printf "export const App = 0;\n" >"$work_dir/src/app/index.ts"
expect 1 "an app/ folder coming back fails" "the dissolved app/ folder is back"

# --- tests/ are out of scope -------------------------------------------------

reset_tree
add tests/layout/sidebar.test.tsx <<'FIXTURE'
import { Sidebar } from '../../items/workspace-sidebar';
import { announce } from '../../a11y/announcer';
export const t = [Sidebar, announce];
FIXTURE
expect 0 "tests may import anything"

reset_tree
add layout/tests/helper.ts <<'FIXTURE'
import { Sidebar } from '../../items/workspace-sidebar';
export const s = Sidebar;
FIXTURE
expect 0 "a tests directory nested inside a leaf is pruned too"

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

printf '\ncheck-frontend-layering.test: %d passed, %d failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
