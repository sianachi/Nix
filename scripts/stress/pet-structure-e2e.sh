#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

for variable in NIX_SESSION_TOKEN NIX_API_URL WORKSPACE PET; do
  if [[ -z "${!variable:-}" ]]; then
    printf 'Required environment variable %s is missing.\n' "$variable" >&2
    exit 2
  fi
done

if command -v nixctl >/dev/null 2>&1; then
  nixctl_cmd() { nixctl --json "$@"; }
else
  nixctl_cmd() {
    pnpm --filter @nix/cli exec node --experimental-strip-types src/index.ts --json "$@"
  }
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

pet_cmd() {
  nixctl_cmd pet --api-url "$NIX_API_URL" --workspace "$WORKSPACE" --pet "$PET" "$@"
}

poll_tool() {
  local operation="$1"
  local deadline=$((SECONDS + 90))
  local runtime tool_id
  while ((SECONDS < deadline)); do
    runtime="$(pet_cmd read)"
    tool_id="$(node -e '
      const runtime = JSON.parse(process.argv[1]);
      for (const tool of runtime.tools ?? []) {
        if (tool.status !== "pending") continue;
        try {
          if (JSON.parse(tool.arguments).operation === process.argv[2]) {
            process.stdout.write(tool.id);
            break;
          }
        } catch {}
      }
    ' "$runtime" "$operation")"
    if [[ -n "$tool_id" ]]; then
      printf '%s' "$tool_id"
      return 0
    fi
    sleep 3
  done
  printf 'No pending %s call appeared within 90 seconds.\n' "$operation" >&2
  return 1
}

preview_and_approve() {
  local tool_id="$1"
  local preview_file="$2"
  pet_cmd tools run "$tool_id" > "$preview_file"
  node -e '
    const result = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const preview = result.preview ?? result;
    if (!preview || !Array.isArray(preview.problems) || preview.problems.length > 0) {
      throw new Error(`Preview has problems or is missing: ${JSON.stringify(preview)}`);
    }
    process.stdout.write(`${preview.headline}\n`);
  ' "$preview_file"
  pet_cmd tools run "$tool_id" --approve
}

parent_instruction='at the top level of this workspace'
parent_option=()
if [[ -n "${PARENT:-}" ]]; then
  parent_instruction="under the item $PARENT"
  parent_option=(--parent "$PARENT")
fi

pet_cmd send --workspace-tools --message \
  "Create a board called Reading log $parent_instruction with Status (To read, Reading, Done) and Rating (number)." \
  > "$tmpdir/send-structure.json"
structure_tool="$(poll_tool create_structured)"
preview_and_approve "$structure_tool" "$tmpdir/structure-preview.json"

nixctl_cmd item ls --workspace "$WORKSPACE" "${parent_option[@]}" > "$tmpdir/roots.json"
board_id="$(node -e '
  const result = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const board = result.items?.find((item) => item.title === "Reading log");
  if (!board) throw new Error("The approved Reading log board is absent from the destination.");
  process.stdout.write(board.id);
' "$tmpdir/roots.json")"

nixctl_cmd views get "$board_id" > "$tmpdir/views.json"
nixctl_cmd schema get "$board_id" > "$tmpdir/schema.json"
node -e '
  const fs = require("node:fs");
  const views = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const schema = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  if (!views.views?.some((view) => view.kind === "board")) throw new Error("The board view is missing.");
  const fields = new Map(schema.properties?.map((field) => [field.key, field]) ?? []);
  const status = fields.get("status");
  const rating = fields.get("rating");
  if (status?.type !== "select" || status.options.join(",") !== "To read,Reading,Done") throw new Error("The Status field does not match the requested options.");
  if (rating?.type !== "number") throw new Error("The Rating number field is missing.");
  process.stdout.write("Verified board view, Status options and Rating number field.\n");
' "$tmpdir/views.json" "$tmpdir/schema.json"

pet_cmd send --workspace-tools --message \
  "Add two entries under the Reading log board: Book 1 with Status To read and Rating 0, and Book 2 with Status Reading and Rating 4." \
  > "$tmpdir/send-entries.json"
entries_tool="$(poll_tool create_entries)"
preview_and_approve "$entries_tool" "$tmpdir/entries-preview.json"

nixctl_cmd item ls --workspace "$WORKSPACE" --parent "$board_id" > "$tmpdir/entries.json"
node -e '
  const result = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const names = new Set(result.items?.map((item) => item.title) ?? []);
  for (const title of ["Book 1", "Book 2"]) if (!names.has(title)) throw new Error(`Entry ${title} is missing.`);
  process.stdout.write("Verified both created entries.\n");
' "$tmpdir/entries.json"

nixctl_cmd structure read "$board_id" > "$tmpdir/structure.json"
node -e '
  const result = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (result.childCount !== 2) throw new Error(`Expected childCount 2, received ${String(result.childCount)}.`);
  process.stdout.write(`Verified read_structure childCount=${result.childCount}.\n`);
' "$tmpdir/structure.json"

printf 'Phase A structure end-to-end passed for board %s.\n' "$board_id"
