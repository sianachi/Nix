#!/usr/bin/env bash
# Guard: the layering that project boundaries used to enforce (ADR-0015).
#
# Until the backend collapsed into one project, three DependencyDirectionTests
# asserted against compiled assembly references that Nix.Core could not reference
# Npgsql, EF Core or ASP.NET. That check is not merely weakened by the collapse,
# it is unexpressible: there is one assembly now, and its reference list contains
# all three. This script replaces it with a source-level check.
#
# Be clear about what this is worth. It catches the ordinary mistake - someone
# adds `using Npgsql;` to a domain file - and fails the build with a file and a
# line. It does not catch a determined one: `var` hides a type the file never
# spells, inference inside a lambda is invisible to grep, a reach through a
# Domain/ helper passes every pattern below, and a `using` alias defeats
# name-matching by construction. The crown jewels were never guarded by this
# check anyway - permission filtering lives inside each handler's query, and RLS
# is proven by two-tenant Testcontainers tests against real grants. This is a
# shape guard that went from proof to strong hint. If Domain/ ever outgrows the
# point where reading the diff is a real control, replace this with a Roslyn
# analyzer; "the grep missed one" is the trigger to do it.
#
# Rules enforced:
#
#   1. Domain/ names no infrastructure - no EF Core, no Npgsql, no ASP.NET - and
#      does not reach outward into Persistence/ or Features/.
#   2. Features/ does not touch the database directly. Handlers reach storage
#      through the ports in Abstractions/, so that there is one place where a
#      query is written and one place where permission filtering happens.
#
# Scope is backend/src/Nix.Api. Test code may host whatever it needs.
#
# Portable across BSD (macOS) and GNU grep: only -r, -n, -E, --include and
# --exclude-dir are used, and the patterns avoid word-boundary escapes
# (\b, \<, [[:<:]]) which the two implementations spell differently.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

api_dir="backend/src/Nix.Api"
domain_dir="$api_dir/Domain"
features_dir="$api_dir/Features"

if [ ! -d "$domain_dir" ]; then
  echo "check-layering: $domain_dir not found; nothing to check." >&2
  exit 0
fi

# grep exits 1 when nothing matches; that is the good case here, so soak it up.
scan() {
  pattern="$1"
  target="$2"
  if [ ! -d "$target" ]; then
    return 0
  fi
  grep -rnE --include='*.cs' --exclude-dir=obj --exclude-dir=bin "$pattern" "$target" || true
}

# Matches both `using Npgsql;` / `using Microsoft.EntityFrameworkCore.X;` and a
# fully-qualified `Npgsql.NpgsqlConnection` written inline without a using.
infrastructure_pattern='(using[[:space:]]+)?(Npgsql|Microsoft\.EntityFrameworkCore|Microsoft\.AspNetCore)[.;]'

# Domain must not reach outward into the layers that depend on it.
outward_pattern='using[[:space:]]+Nix\.(Persistence|Features|Messaging|Errors|Authentication|Serialization|Contracts)[.;]'

# A feature that names the context or a raw connection has gone around the ports.
db_handle_pattern='(NixDbContext|NpgsqlDataSource|NpgsqlConnection|NpgsqlCommand)'

domain_infrastructure="$(scan "$infrastructure_pattern" "$domain_dir")"
domain_outward="$(scan "$outward_pattern" "$domain_dir")"
features_db="$(scan "$db_handle_pattern" "$features_dir")"

if [ -z "$domain_infrastructure" ] && [ -z "$domain_outward" ] && [ -z "$features_db" ]; then
  echo "check-layering: OK (Domain/ is free of infrastructure; Features/ reaches storage through ports)."
  exit 0
fi

echo "check-layering: FAIL" >&2

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

report "Domain/ names infrastructure (EF Core, Npgsql, or ASP.NET):" "$domain_infrastructure"
report "Domain/ reaches outward into a layer that depends on it:" "$domain_outward"
report "Features/ touches the database directly instead of through a port:" "$features_db"

echo >&2
echo "Rule: Domain/ is the model and carries no infrastructure - its one third-party" >&2
echo "reference is NodaTime, which is value types with no I/O (ADR-0012). Features/" >&2
echo "reaches storage through the ports in Abstractions/, implemented in Persistence/," >&2
echo "so that permission filtering happens during query evaluation and in one place." >&2
echo "See ADR-0015 for why this is a script rather than a test." >&2
exit 1
