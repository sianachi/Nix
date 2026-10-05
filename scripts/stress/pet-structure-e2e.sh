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

nixctl_cmd() {
  pnpm --filter @nix/cli exec node --experimental-strip-types src/index.ts --json "$@"
}

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

if [[ "${1:-}" != 'phase-b' ]]; then
  exit 0
fi

# Phase B proves additive fields and a form replacement against the same item created above.
cp "$tmpdir/schema.json" "$tmpdir/schema-before-fields.json"
pet_cmd send --workspace-tools --message \
  "On the Reading log board $board_id, add Finished on (date), Notes (text), and Due date (the task due_date field). Keep Status and Rating unchanged." \
  > "$tmpdir/send-fields.json"
fields_tool="$(poll_tool add_fields)"
preview_and_approve "$fields_tool" "$tmpdir/fields-preview.json"
nixctl_cmd schema get "$board_id" > "$tmpdir/schema-after-fields.json"
jq -e -n \
  --slurpfile before "$tmpdir/schema-before-fields.json" \
  --slurpfile after "$tmpdir/schema-after-fields.json" '
    ($before[0].properties) as $old |
    ($after[0].properties) as $new |
    all($old[]; . as $field | any($new[]; . == $field)) and
    ([{"key":"finished_on","type":"date"}, {"key":"notes","type":"text"}, {"key":"due_date","type":"due_date"}] |
      all(.[]; . as $expected | any($new[]; .key == $expected.key and .type == $expected.type))) and
    ($new | length) == (($old | length) + 3)
  ' >/dev/null
printf 'Verified schema additions only: Finished on, Notes and Due date.\n'

pet_cmd send --workspace-tools --message \
  "Turn the Reading log note $board_id into an interactive form. Add a form view that asks Status and Rating. Keep its existing board view." \
  > "$tmpdir/send-form.json"
form_tool="$(poll_tool add_view)"
preview_and_approve "$form_tool" "$tmpdir/form-preview.json"
nixctl_cmd views inspect "$board_id" > "$tmpdir/form-before-link.json"
node -e '
  const fs = require("node:fs");
  const saved = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const form = saved.views?.find((view) => view.kind === "interactive_form");
  const board = saved.views?.find((view) => view.kind === "board");
  if (!form || !board) throw new Error("The form or its existing board view is missing.");
  form.companionViewId = board.id;
  form.companionPlacement = "below";
  fs.writeFileSync(process.argv[2], JSON.stringify({ views: saved.views, default: saved.default }));
' "$tmpdir/form-before-link.json" "$tmpdir/linked-form.json"
nixctl_cmd views set "$board_id" --file "$tmpdir/linked-form.json" > "$tmpdir/link-result.json"

pet_cmd send --workspace-tools --message \
  "Edit the interactive form on Reading log $board_id. Keep the Status and Rating questions, then add a Finished on question shown only when Status equals Done. Keep the companion board view." \
  > "$tmpdir/send-form-edit.json"
form_edit_tool="$(poll_tool edit_form)"
preview_and_approve "$form_edit_tool" "$tmpdir/form-edit-preview.json"
# The summary proves both views remain; inspect retains the saved form blocks and conditions.
nixctl_cmd views get "$board_id" > "$tmpdir/form-views.json"
nixctl_cmd views inspect "$board_id" > "$tmpdir/form-after-edit.json"
node -e '
  const fs = require("node:fs");
  const summary = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const saved = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  if (!summary.views?.some((view) => view.kind === "board") || !summary.views?.some((view) => view.kind === "interactive_form")) {
    throw new Error("The form or its companion board view is missing.");
  }
  const form = saved.views?.find((view) => view.kind === "interactive_form");
  const board = saved.views?.find((view) => view.kind === "board");
  if (form?.companionViewId !== board?.id) throw new Error("The form lost its companion view.");
  const blocks = form.interactiveForm?.pages?.flatMap((page) => page.blocks ?? []) ?? [];
  const status = blocks.find((block) => block.propertyKey === "status");
  const finished = blocks.find((block) => block.propertyKey === "finished_on");
  if (!status || !finished?.visibleWhen?.some((condition) =>
    condition.fieldBlockId === status.id && condition.operator === "equals" && condition.value === "Done")) {
    throw new Error("The Finished on question or its Status condition is missing.");
  }
  process.stdout.write("Verified form condition and preserved companion board view.\n");
' "$tmpdir/form-views.json" "$tmpdir/form-after-edit.json"

pet_cmd send --workspace-tools --message \
  "Add a calendar view to Reading log $board_id that uses its Due date field. Keep the board and form views." \
  > "$tmpdir/send-calendar.json"
calendar_tool="$(poll_tool add_view)"
preview_and_approve "$calendar_tool" "$tmpdir/calendar-preview.json"
nixctl_cmd views get "$board_id" > "$tmpdir/calendar-views.json"
jq -e '.views | any(.[]; .kind == "calendar")' "$tmpdir/calendar-views.json" >/dev/null

book_id="$(jq -r '.items[] | select(.title == "Book 1") | .id' "$tmpdir/entries.json")"
if [[ -z "$book_id" || "$book_id" == 'null' ]]; then
  printf 'Book 1 is missing from the Phase A entries.\n' >&2
  exit 1
fi
read -r due_date calendar_to < <(node -e '
  const now = new Date();
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const end = new Date(day.valueOf() + 35 * 86400000);
  process.stdout.write(`${day.toISOString().slice(0, 10)} ${end.toISOString().slice(0, 10)}\n`);
')
nixctl_cmd props set "$book_id" "due_date=$due_date" > "$tmpdir/due-date.json"
pet_cmd send --workspace-tools --message \
  "Set a weekly recurrence on Book 1, item $book_id. Its Due date is $due_date. Repeat every week." \
  > "$tmpdir/send-recurrence.json"
recurrence_tool="$(poll_tool set_recurrence)"
preview_and_approve "$recurrence_tool" "$tmpdir/recurrence-preview.json"
# Core has no recurrence GET; a generated calendar entry proves the saved rule is active.
nixctl_cmd calendar --workspace "$WORKSPACE" --from "$due_date" --to "$calendar_to" > "$tmpdir/calendar.json"
jq -e --arg item "$book_id" '.entries | any(.[]; .itemId == $item and .generated == true)' "$tmpdir/calendar.json" >/dev/null
printf 'Verified weekly recurrence through generated calendar entries for %s.\n' "$book_id"
printf 'Phase B structure end-to-end passed for board %s.\n' "$board_id"
