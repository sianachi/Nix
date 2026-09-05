#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
planner="$script_dir/changed-path-checks.sh"

assert_contains() {
  output=$1
  expected=$2
  case "$output" in
    *"$expected"*) ;;
    *) echo "expected output to contain: $expected" >&2; exit 1 ;;
  esac
}

web_output=$("$planner" apps/web/src/app.tsx)
assert_contains "$web_output" 'pnpm --filter @nix/web typecheck'
assert_contains "$web_output" 'check-frontend-layering.sh'

package_output=$("$planner" packages/ui/src/controls/button.tsx)
assert_contains "$package_output" 'pnpm --filter @nix/ui test'

backend_output=$("$planner" backend/src/Nix.Api/Authentication/UserInfoClient.cs)
assert_contains "$backend_output" 'dotnet test backend/tests/Nix.Integration.Tests/Nix.Integration.Tests.csproj'
assert_contains "$backend_output" 'Required review: security'

contract_output=$("$planner" backend/openapi/nix-api.json)
assert_contains "$contract_output" 'pnpm --filter @nix/api-client generate'

worker_output=$("$planner" apps/go-workers/internal/runtime/runtime.go)
assert_contains "$worker_output" 'go test -race ./...'

command_output=$("$planner" --commands backend/openapi/nix-api.json)
assert_contains "$command_output" 'NixGenerateOpenApiContract=true'
case "$command_output" in
  *'Changed paths:'*) echo 'command output must not include prose' >&2; exit 1 ;;
esac

workflow_output=$("$planner" scripts/validate-changed.sh)
assert_contains "$workflow_output" 'validate-changed.test.sh'

compose_output=$("$planner" deploy/compose.prod.yml)
assert_contains "$compose_output" 'bash deploy/compose/check.test.sh'

fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
git -C "$fixture" init -q
git -C "$fixture" -c user.name=Fixture -c user.email=fixture@example.invalid commit --quiet --allow-empty -m fixture
empty_output=$(cd "$fixture" && "$planner" --working-tree)
assert_contains "$empty_output" 'No changed paths detected'
mkdir -p "$fixture/deploy"
touch "$fixture/deploy/compose.prod.yml"
dirty_output=$(cd "$fixture" && "$planner" --working-tree)
assert_contains "$dirty_output" 'Changed paths:'
assert_contains "$dirty_output" 'bash deploy/compose/check.test.sh'

echo 'changed-path-checks.test: passed'
