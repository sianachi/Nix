#!/usr/bin/env bash
# Guard: minimal APIs only (engineering plan section 2.3).
#
# MVC controllers are prohibited outright, not discouraged: a second request
# pipeline costs reflection-based action invocation on every request (a section 3
# concern) and splits "where do routes live" into two answers. The rule is only
# real if a machine enforces it, so this script fails the build on:
#
#   1. a type deriving from Controller or ControllerBase
#   2. an [ApiController] attribute
#   3. AddControllers()/MapControllers() and their MVC siblings
#
# Explicitly NOT flagged: Microsoft.AspNetCore.Mvc.ProblemDetails and
# ValidationProblemDetails. Those are RFC 9457 payload types, allowed everywhere;
# the prohibition is on controllers, not on the namespace.
#
# Scope is backend/src. Test code may host whatever it needs to prove a point.
#
# Portable across BSD (macOS) and GNU grep: only -r, -n, -E, --include and
# --exclude-dir are used, and the patterns avoid word-boundary escapes
# (\b, \<, [[:<:]]) which the two implementations spell differently.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

src_dir="backend/src"

if [ ! -d "$src_dir" ]; then
  echo "check-no-controllers: $src_dir not found; nothing to check." >&2
  exit 0
fi

# Matches a base list naming Controller or ControllerBase, with or without a
# namespace qualifier, terminated by end of line, an interface list, a brace or a
# comment. The terminator is what keeps ': MyControllerBaseHelper' from matching.
derived_pattern=':[[:space:]]*([A-Za-z_][A-Za-z0-9_.]*\.)?Controller(Base)?[[:space:]]*($|[,{/])'
attribute_pattern='\[[[:space:]]*(Microsoft\.AspNetCore\.Mvc\.)?ApiController[[:space:]]*[],(]'
registration_pattern='(Add(Controllers|ControllersWithViews|Mvc)|Map(Controllers|ControllerRoute|DefaultControllerRoute|AreaControllerRoute))[[:space:]]*[(<]'

# grep exits 1 when nothing matches; that is the good case here, so soak it up.
scan() {
  grep -rnE --include='*.cs' --exclude-dir=obj --exclude-dir=bin "$1" "$src_dir" || true
}

derived="$(scan "$derived_pattern")"
attribute="$(scan "$attribute_pattern")"
registration="$(scan "$registration_pattern")"

if [ -z "$derived" ] && [ -z "$attribute" ] && [ -z "$registration" ]; then
  echo "check-no-controllers: OK (no MVC controller surface under $src_dir)."
  exit 0
fi

echo "check-no-controllers: FAIL" >&2

report() {
  heading="$1"
  matches="$2"
  if [ -n "$matches" ]; then
    echo "$heading" >&2
    printf '%s\n' "$matches" | while IFS= read -r line; do
      printf '  %s\n' "$line" >&2
    done
  fi
}

report "Type derived from Controller/ControllerBase:" "$derived"
report "[ApiController] attribute:" "$attribute"
report "MVC controller registration (AddControllers/MapControllers and siblings):" "$registration"

echo >&2
echo "Rule: minimal APIs only. Register routes with a Map<Feature>Endpoints()" >&2
echo "extension composed via MapGroup, and put cross-cutting behavior in endpoint" >&2
echo "filters or middleware (engineering plan section 2.3)." >&2
exit 1
