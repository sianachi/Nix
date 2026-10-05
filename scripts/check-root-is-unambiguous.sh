#!/usr/bin/env bash
# Guard: exactly one project or solution file at the repository root.
#
# The .NET CLI picks its target by scanning the current directory. When more than
# one candidate is there, `dotnet build`, `dotnet test`, `dotnet format` and
# `dotnet run` all refuse with MSB1011, "this folder contains more than one
# project or solution file", and every documented command has to be requalified.
# The repository has been in that state once already: Nix.slnx at the root next
# to a Nix.Frontend.csproj browse shim, since moved into Nix.Frontend/.
#
# The failure is cheap to reintroduce - drop one benchmark or tooling project at
# the root and it is back - and expensive to diagnose, because the obvious fixes
# do not work. A global.json only pins the SDK version and has no say in target
# selection; a Directory.Build.rsp appears to fix the bare command while breaking
# the explicit ones CI uses; renaming the extension changes nothing, because
# discovery matches *.*proj generically. Nobody should have to rediscover that.
#
# So: the root holds Nix.slnx and nothing else of that shape. Projects live in a
# subdirectory. Scope is the root itself, not a recursive scan - nested projects
# are exactly the arrangement this protects.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

# -maxdepth 1 keeps this to the root. Globs rather than a regex so it reads the
# way the CLI's own discovery does, and matches BSD (macOS) and GNU find alike.
candidates="$(find . -maxdepth 1 -type f \
  \( -name '*.sln' -o -name '*.slnx' -o -name '*.*proj' \) \
  | sed 's|^\./||' | sort)"

count="$(printf '%s' "$candidates" | grep -c . || true)"

if [ "$count" -eq 1 ]; then
  echo "check-root-is-unambiguous: OK ($candidates is the only root build file)."
  exit 0
fi

echo "check-root-is-unambiguous: FAIL" >&2
echo >&2

if [ "$count" -eq 0 ]; then
  echo "The repository root holds no solution or project file. Nix.slnx is expected" >&2
  echo "there so that one IDE window covers both lanes and a bare dotnet command" >&2
  echo "resolves to the whole solution." >&2
else
  echo "The repository root holds $count project/solution files:" >&2
  printf '%s\n' "$candidates" | while IFS= read -r line; do
    printf '  %s\n' "$line" >&2
  done
  echo >&2
  echo "The .NET CLI cannot choose between them, so every bare dotnet command at" >&2
  echo "the root fails with MSB1011. Move all but Nix.slnx into a subdirectory" >&2
  echo "named for the project (see Nix.Frontend/ for the pattern) and reference it" >&2
  echo "from Nix.slnx." >&2
fi

exit 1
