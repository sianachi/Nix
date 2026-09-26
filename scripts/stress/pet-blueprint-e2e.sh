#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

fixture="$repo_root/packages/structure-spec/fixtures/blueprints/reading-log.json"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

nixctl() {
  node --experimental-strip-types "$repo_root/apps/cli/src/index.ts" --json "$@"
}

assert_report_ok() {
  node -e '
    const report = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    if (report.ok !== true) throw new Error(`Expected a valid blueprint: ${JSON.stringify(report.problems)}`);
  ' "$1"
}

assert_report_problem_path() {
  node -e '
    const report = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const expected = process.argv[2];
    if (report.ok !== false || !report.problems?.some((problem) => problem.path === expected)) {
      throw new Error(`Expected validation failure at ${expected}: ${JSON.stringify(report)}`);
    }
  ' "$1" "$2"
}

nixctl blueprint validate "$fixture" > "$tmpdir/reading-log-validation.json"
assert_report_ok "$tmpdir/reading-log-validation.json"
printf 'Validated reading-log blueprint offline.\n'

node -e '
  const fs = require("node:fs");
  const blueprint = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  blueprint.root.fields.push({
    label: "Missing source total",
    type: "rollup",
    rollup: { aggregate: "sum", source: "missing_source" },
  });
  fs.writeFileSync(process.argv[2], JSON.stringify(blueprint));
' "$fixture" "$tmpdir/invalid-rollup.json"
set +e
nixctl blueprint validate "$tmpdir/invalid-rollup.json" > "$tmpdir/invalid-rollup-report.json" 2> "$tmpdir/invalid-rollup-error.txt"
invalid_status=$?
set -e
if [[ "$invalid_status" -ne 1 ]]; then
  cat "$tmpdir/invalid-rollup-error.txt" >&2
  printf 'Expected invalid rollup validation to exit 1; received %s.\n' "$invalid_status" >&2
  exit 1
fi
assert_report_problem_path "$tmpdir/invalid-rollup-report.json" 'root.fields[2].rollup.source'
printf 'Rejected invalid rollup source at root.fields[2].rollup.source with exit 1.\n'

node -e '
  const fs = require("node:fs");
  const children = Array.from({ length: 39 }, (_, index) => ({
    id: `node-${String(index + 1).padStart(2, "0")}`,
    title: `Budget node ${String(index + 1).padStart(2, "0")}`,
    ...(index >= 14 ? { sample: true } : {}),
  }));
  const blueprint = {
    version: 1,
    title: "Forty node rate-limit check",
    summary: "A bounded 40-node sequential build used to check write volume.",
    root: {
      id: "budget-root",
      title: "Forty node rate-limit check",
      fields: [{ label: "Name", type: "text" }],
      views: [{ kind: "list" }],
      children,
    },
  };
  fs.writeFileSync(process.argv[1], JSON.stringify(blueprint));
' "$tmpdir/forty-node.json"
nixctl blueprint validate "$tmpdir/forty-node.json" > "$tmpdir/forty-node-validation.json"
assert_report_ok "$tmpdir/forty-node-validation.json"
printf 'Validated the 40-node build fixture offline.\n'

if [[ -n "${NIX_SESSION_TOKEN:-}" && -z "${NIX_API_URL:-}" ]]; then
  printf 'Live acceptance remains open: NIX_SESSION_TOKEN is set but NIX_API_URL is missing.\n' >&2
  exit 2
fi
if [[ -z "${NIX_SESSION_TOKEN:-}" ]]; then
  if ! nixctl auth status > "$tmpdir/profile-status.json" 2> "$tmpdir/profile-status-error.txt"; then
    detail="$(cat "$tmpdir/profile-status-error.txt")"
    printf 'Live acceptance remains open: no reachable stored nixctl credential (%s).\n' "$detail" >&2
    printf 'Provide a working stored profile or set NIX_SESSION_TOKEN and NIX_API_URL.\n' >&2
    exit 2
  fi
fi
if [[ -z "${WORKSPACE:-}" ]]; then
  printf 'Live acceptance remains open: WORKSPACE is missing.\n' >&2
  printf 'Set WORKSPACE to the dev workspace id, then rerun this script.\n' >&2
  exit 2
fi

nixctl blueprint build "$fixture" --workspace "$WORKSPACE" --yes > "$tmpdir/reading-log-build.json"
node -e '
  const fs = require("node:fs");
  const build = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (build.complete !== true || typeof build.rootId !== "string") {
    throw new Error(`Reading-log build did not complete: ${JSON.stringify(build)}`);
  }
  process.stdout.write(`${build.rootId}\n`);
' "$tmpdir/reading-log-build.json" > "$tmpdir/reading-log-root-id.txt"
root_id="$(cat "$tmpdir/reading-log-root-id.txt")"

nixctl item ls --workspace "$WORKSPACE" > "$tmpdir/workspace-roots.json"
node -e '
  const fs = require("node:fs");
  const rows = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).items ?? [];
  const sandbox = rows.find((item) => item.title === "Pet drafts");
  if (!sandbox) throw new Error("Pet drafts is missing from the workspace roots.");
  fs.writeFileSync(process.argv[2], sandbox.id);
' "$tmpdir/workspace-roots.json" "$tmpdir/sandbox-id.txt"
sandbox_id="$(cat "$tmpdir/sandbox-id.txt")"
nixctl item ls --workspace "$WORKSPACE" --parent "$sandbox_id" > "$tmpdir/sandbox-children.json"
node -e '
  const fs = require("node:fs");
  const rows = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).items ?? [];
  const root = rows.find((item) => item.id === process.argv[2] && item.title === "Reading Log");
  if (!root) throw new Error("Reading Log is not a child of Pet drafts.");
' "$tmpdir/sandbox-children.json" "$root_id"
nixctl item ls --workspace "$WORKSPACE" --parent "$root_id" > "$tmpdir/reading-log-children.json"
node -e '
  const fs = require("node:fs");
  const rows = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).items ?? [];
  const names = new Set(rows.map((item) => item.title));
  for (const title of ["The Hobbit", "Dune", "Reading notes", "Goals", "Reading habits"]) {
    if (!names.has(title)) throw new Error(`Reading Log child ${title} is missing.`);
  }
  const goals = rows.find((item) => item.title === "Goals");
  fs.writeFileSync(process.argv[2], goals.id);
' "$tmpdir/reading-log-children.json" "$tmpdir/goals-id.txt"
goals_id="$(cat "$tmpdir/goals-id.txt")"
nixctl item ls --workspace "$WORKSPACE" --parent "$goals_id" > "$tmpdir/goal-children.json"
node -e '
  const fs = require("node:fs");
  const rows = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).items ?? [];
  if (!rows.some((item) => item.title === "2026 goal")) throw new Error("The nested 2026 goal item is missing.");
' "$tmpdir/goal-children.json"
nixctl views get "$root_id" > "$tmpdir/reading-log-views.json"
nixctl schema get "$root_id" > "$tmpdir/reading-log-schema.json"
node -e '
  const fs = require("node:fs");
  const views = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const schema = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  if (!views.views?.some((view) => view.kind === "board")) throw new Error("Reading Log board view is missing.");
  const fields = new Map(schema.properties?.map((field) => [field.key, field]) ?? []);
  const status = fields.get("status");
  const rating = fields.get("rating");
  if (status?.type !== "select" || status.options.join(",") !== "To read,Reading,Done") throw new Error("Status field/options do not match the fixture.");
  if (rating?.type !== "number") throw new Error("Rating number field is missing.");
' "$tmpdir/reading-log-views.json" "$tmpdir/reading-log-schema.json"
node -e '
  const fs = require("node:fs");
  const build = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const writes = build.ledger.filter((entry) => entry.status === "done").length;
  process.stdout.write(`Reading-log build complete: ${writes} write requests; root ${build.rootId}.\n`);
' "$tmpdir/reading-log-build.json"

start_time_ms="$(node -p 'Date.now()')"
nixctl blueprint build "$tmpdir/forty-node.json" --workspace "$WORKSPACE" --yes > "$tmpdir/forty-node-build.json"
end_time_ms="$(node -p 'Date.now()')"
elapsed_ms=$((end_time_ms - start_time_ms))
node -e '
  const fs = require("node:fs");
  const build = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const writes = build.ledger.filter((entry) => entry.status === "done").length;
  if (build.complete !== true || writes !== 40 || writes > 80) {
    throw new Error(`Expected 40 completed writes within the 80-write cap: ${JSON.stringify(build)}`);
  }
  process.stdout.write(`Forty-node build complete: ${writes} write requests.\n`);
' "$tmpdir/forty-node-build.json"
printf 'Elapsed time: %s ms.\n' "$elapsed_ms"
printf 'C.5 live blueprint acceptance passed for workspace %s.\n' "$WORKSPACE"
