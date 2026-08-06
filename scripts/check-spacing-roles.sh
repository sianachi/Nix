#!/usr/bin/env bash
# Guard: a structural role uses one spacing step, everywhere it appears (U13).
#
# `check-raw-design-values.sh` catches a raw pixel value; it cannot catch a real, valid token
# chosen wrongly, because "p-2" is exactly as legitimate a class as "p-3" - the guard has no way
# to know which one a given shape is supposed to wear. That gap is what U13's audit fell into:
# `board-view.tsx`'s column panel was `border border-divider p-2` while five structurally
# identical panels elsewhere - the calendar's unscheduled tray, the timeline's off-axis lists and
# reschedule panel, the schema and view editors' draft rows - were all `p-3`. Every one of the six
# is a bordered, column-stacked group at `gap-2`; nothing about the shape says which padding step
# is "the" one, so nothing caught the sixth one drifting until somebody looked at all six side by
# side.
#
# This guard is that look, kept running. It defines a small table of structural roles - a
# co-occurring set of classes that names a shape - and the one spacing step that shape has always
# used elsewhere in the tree. A line that matches a role's shape and does not also carry its
# required step fails.
#
# **Why a role rather than a per-file check.** A component that uses two different paddings for
# "the same thing" *within itself* is a bug this guard would also catch, since both occurrences are
# checked against the same required step - but the failure U13 actually found was never local to
# one file. Six files agreed and a seventh did not; only a check that runs across the whole tree,
# against a step named once, can see that.
#
# **What this cannot see, by construction - matching the sibling guard's own disclosure:**
#   - A role's classes split across a multi-line `cn(...)` call. Matching is line-based, the same
#     restriction `check-raw-design-values.sh` accepts for the same reason (parsing TSX is far past
#     what a guard should carry): `board-view.tsx`'s own column panel is inside a `cn(...)` call and
#     is only covered because its class *string* still fits on one line. A reformat that folded
#     `'flex w-80 shrink-0 flex-col gap-2 border border-divider p-3'` onto two lines would silently
#     drop out of coverage rather than fail loudly - there is no way to tell "this rule doesn't
#     apply" from "this rule can't see" from the output, which is the honest limit of a line-oriented
#     check.
#   - Two different elements that both match a role's shape on the same source line (unlikely in
#     formatted JSX, but not impossible) - the allowed step from either one satisfies the check for
#     both.
#   - A role satisfied by a *different* utility carrying the same visual weight, e.g. `px-3 py-3` in
#     place of `p-3`, or a responsive override (`md:p-3`) sitting alongside a base `p-2`. The table
#     below asks for one literal spelling, not the rendered result.
#   - A shape assembled from a shared constant rather than spelled out on the line, e.g.
#     `gallery-view.tsx`'s card - `cn(blueprintFrame, 'relative flex flex-col gap-2 bg-surface p-3
#     shadow-sm')` - is a bordered group in every way that matters visually (`blueprintFrame` is
#     `'rounded-md border border-divider'`), but the literal text `border-divider` never appears on
#     that line, so this guard cannot see it. A green run says "no *visible* violation", not "every
#     bordered group agrees".
#
# Adding a role: a shape becomes worth naming here once it recurs - two instances are a
# coincidence, three are a convention, and the convention has to be expressible as classes
# co-occurring on one line. (The calendar view's root wrapper drifting to `gap-4` while the board's,
# the gallery's and the timeline's agreed on `gap-3` - also found and fixed in this same pass - is
# not a role here for exactly that reason: "the outermost returned element of a view-rendering
# module" is a fact about a file's structure, not about a line's classes, and no set of co-occurring
# tokens picks that element out from the `gap-4` root wrappers `editor-shell.tsx`, `schema-editor.tsx`
# and `view-editor.tsx` legitimately use for their own, different, panel-editor role.) Register a new
# role with `register_role`, naming the classes that make the shape recognisable - as few as still
# uniquely identify it - and the step the convention actually settled on, pulled from the majority of
# existing call sites rather than from taste.
#
# Scope:   *.ts, *.tsx under packages/ and apps/, matching check-raw-design-values.sh
# Skipped: packages/design-tokens, node_modules, dist
# Exempt:  - a line containing a 'spacing-role-exempt' comment
#          - a whole file containing 'spacing-role-exempt-file'
#          - a line that opens with '//' or '/*'
#
# Usage:   check-spacing-roles.sh [root ...]
#          With no arguments it scans packages/ and apps/ from the repo root, which is what CI
#          runs. Explicit roots exist so the test suite can point this at a fixture corpus - see
#          check-spacing-roles.test.sh.
#
# Exits 0 cleanly when packages/ or apps/ do not exist yet.
#
# Portable across BSD (macOS) and GNU tools: no \b (BSD grep does not support it), bash 3.2
# compatible (no namerefs, no associative arrays - role definitions are parallel indexed arrays,
# with each role's require-pattern list flattened into one string on a separator byte and split
# back out at scan time, since bash 3.2 cannot hold an array of arrays).
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"

scan_roots=()
if [ "$#" -gt 0 ]; then
  for root in "$@"; do
    if [ ! -d "$root" ]; then
      echo "check-spacing-roles: '$root' is not a directory." >&2
      exit 2
    fi
    scan_roots+=("$root")
  done
else
  cd "$repo_root"
  for root in packages apps; do
    [ -d "$root" ] && scan_roots+=("$root")
  done
  if [ "${#scan_roots[@]}" -eq 0 ]; then
    echo "check-spacing-roles: OK (no packages/ or apps/ directories yet)."
    exit 0
  fi
fi

# The characters Tailwind glues onto a utility name: letters, digits, colons (variant prefixes),
# slashes (opacity modifiers), dots (fractional steps like gap-0.5) and hyphens. A "word" for our
# purposes has to include hyphen rather than treat it as a boundary - otherwise the token 'p-3'
# would be found inside 'gap-3' (the 'p' three characters in is preceded by 'a', not by a
# boundary, but only once hyphen counts as part of the word does that read correctly). This is the
# *contents* of a bracket expression, not a full one - callers below wrap it in `[...]` or `[^...]`
# themselves, since embedding literal `[`/`]` here to also match arbitrary-value classes would need
# escaping that POSIX bracket expressions do not support.
token_chars='0-9a-zA-Z_:./%-'

# escapeToken <token> - backslash-escapes the ERE metacharacters this sed set actually covers:
# '.', '[', '\', '*', '^', '$', '(', ')', '+', '?', '{', '|'. Only '.' is ever expected in practice
# (Tailwind's fractional steps, e.g. 'gap-0.5'), so a future role naming such a token does not
# silently turn '.' into "any character" and widen the match past the literal class name. Hyphen
# is deliberately not in this set - it is not a metacharacter outside a bracket expression, so it
# needs no escaping here. `]` and `}` are ERE metacharacters this set does NOT cover: a future
# token spelled with either (an arbitrary-value class like 'p-[3px]' escapes its '[' but not its
# ']') would need the set widened first.
escapeToken() {
  printf '%s' "$1" | sed -e 's/[.[\*^$()+?{|]/\\&/g'
}

# tokenPattern <token> - a grep -E fragment matching <token> as a whole class name.
tokenPattern() {
  local escaped
  escaped="$(escapeToken "$1")"
  printf '(^|[^%s])%s([^%s]|$)' "$token_chars" "$escaped" "$token_chars"
}

comment_line_pattern='^[0-9]+:[[:space:]]*(//|/\*)'

# A byte that cannot appear inside a grep -E pattern built from Tailwind class names, used to
# flatten one role's list of require-patterns into a single string a bash 3.2 array-of-strings can
# hold, and split back out at scan time - bash 3.2 has no array-of-arrays to hold the list directly.
FIELD_SEP=$'\x1f'

ROLE_LABELS=()
ROLE_REQUIRES=() # each entry: require-patterns for that role, joined by FIELD_SEP
ROLE_ALLOWED=()
ROLE_MESSAGES=()

# register_role <label> <allowed-pattern> <message> <require-pattern> [require-pattern ...]
#
# label:   short name, printed beside every violation this role reports.
# allowed: a grep -E pattern; a shape line matching it is fine.
# message: the paragraph printed once, only if this role produced at least one violation -
#          explains the convention in prose, since the label alone does not carry it.
# require: one or more grep -E patterns; a line matching all of them is this role's shape.
register_role() {
  local label="$1" allowed="$2" message="$3"
  shift 3
  local joined
  joined="$(printf "%s${FIELD_SEP}" "$@")"
  ROLE_LABELS+=("$label")
  ROLE_ALLOWED+=("$allowed")
  ROLE_MESSAGES+=("$message")
  ROLE_REQUIRES+=("$joined")
}

# Emit "file:line:content" for every line matching every pattern in a role's require-list (i.e.
# every line that matches the role's shape) and not the role's allowed step. Minus comment-only
# lines and exemptions.
scan_role() {
  local file="$1"
  local label="$2"
  local allowed_pattern="$3"
  local requires_joined="$4"

  local require_patterns=()
  local old_ifs="$IFS"
  IFS="$FIELD_SEP"
  # shellcheck disable=SC2206 -- deliberate word-splitting on the field separator, not IFS-default.
  require_patterns=($requires_joined)
  IFS="$old_ifs"

  local candidates
  candidates="$(grep -nE "${require_patterns[0]}" "$file" || true)"
  local i
  for ((i = 1; i < ${#require_patterns[@]}; i++)); do
    [ -n "$candidates" ] || break
    candidates="$(printf '%s\n' "$candidates" | grep -E "${require_patterns[$i]}" || true)"
  done
  [ -n "$candidates" ] || return 0

  # Exemptions and comment-only lines are decided on the real content first, while a
  # 'spacing-role-exempt' marker is still readable - only then is a trailing '//' comment cut away,
  # so a note like "// TODO: was p-3" cannot satisfy the allowed step for a line that is actually
  # 'p-2'. Checking the allowed pattern before stripping would let the required token appear
  # anywhere on the line, comment included, which is exactly the hole a guard whose only job is
  # catching a wrong-but-valid token cannot afford to have.
  local violations
  violations="$(printf '%s\n' "$candidates" \
    | grep -vE "$comment_line_pattern" \
    | grep -v 'spacing-role-exempt' \
    | sed -E 's#//.*$##' \
    | grep -vE "$allowed_pattern" || true)"
  [ -n "$violations" ] || return 0

  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    local lineno="${hit%%:*}"
    printf '[%s] %s:%s:%s\n' "$label" "$file" "$lineno" "$(sed -n "${lineno}p" "$file")"
  done <<EOF
$violations
EOF
}

# ── Role table ──────────────────────────────────────────────────────────────

register_role \
  'bordered group -> p-3' \
  "$(tokenPattern 'p-3')" \
  "A bordered, gap-2, flex-col group pads at p-3 everywhere else it appears (the board's column
panel, the calendar's unscheduled tray, the timeline's off-axis lists and reschedule panel, the
schema and view editors' draft rows). Match that step, or annotate the line with a
'spacing-role-exempt' comment explaining why this one is deliberately different." \
  "$(tokenPattern 'flex-col')" \
  "$(tokenPattern 'gap-2')" \
  "$(tokenPattern 'border-divider')"

# ── Scan ─────────────────────────────────────────────────────────────────────

# Space-separated indices into ROLE_LABELS that produced at least one violation, rather than an
# array: under `set -u`, expanding `${arr[@]}` on a *zero-element* array is treated as an unbound
# variable by bash older than 4.4 - and macOS ships 3.2 - so a plain string sidesteps a crash on the
# common case (no violations yet) instead of relying on a fix this script cannot assume is present.
violated_roles=""
all_violations=""

while IFS= read -r file; do
  [ -n "$file" ] || continue
  if grep -q 'spacing-role-exempt-file' "$file"; then
    continue
  fi

  role_index=0
  while [ "$role_index" -lt "${#ROLE_LABELS[@]}" ]; do
    hits="$(scan_role "$file" "${ROLE_LABELS[$role_index]}" "${ROLE_ALLOWED[$role_index]}" \
      "${ROLE_REQUIRES[$role_index]}")"
    if [ -n "$hits" ]; then
      all_violations="${all_violations}${hits}
"
      case " $violated_roles " in
        *" $role_index "*) ;;
        *) violated_roles="$violated_roles $role_index" ;;
      esac
    fi
    role_index=$((role_index + 1))
  done
done <<EOF2
$(find "${scan_roots[@]}" \
    \( -name node_modules -o -name dist -o -path 'packages/design-tokens' \) -prune \
    -o -type f \( -name '*.ts' -o -name '*.tsx' \) -print)
EOF2

if [ -n "$all_violations" ]; then
  echo "check-spacing-roles: FAIL" >&2
  echo "A structural role's spacing step disagrees with every other place that role appears:" >&2
  printf '%s' "$all_violations" | while IFS= read -r line; do
    [ -n "$line" ] || continue
    printf '  %s\n' "$line" >&2
  done
  echo >&2
  for role_index in $violated_roles; do
    echo "[${ROLE_LABELS[$role_index]}]" >&2
    echo "${ROLE_MESSAGES[$role_index]}" >&2
    echo >&2
  done
  exit 1
fi

echo "check-spacing-roles: OK (every checked structural role uses one spacing step)."
