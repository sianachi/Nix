#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"
umask 077
report_dir="${REPORT_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/nix-pet-consult.XXXXXX")}"
mkdir -p "$report_dir"
transcript="$report_dir/commands.log"
: > "$transcript"
printf 'D.6 command and output report: %s\n' "$report_dir"

build_only_file=""
if [[ "${1:-}" == '--build-only' && -n "${2:-}" && $# -eq 2 ]]; then
  build_only_file="$2"
elif (($# > 0)); then
  printf 'Usage: %s [--build-only blueprint.json]\n' "$0" >&2
  exit 2
fi
required=(NIX_API_URL NIX_SESSION_TOKEN WORKSPACE)
if [[ -z "$build_only_file" ]]; then
  required+=(PET)
fi
for variable in "${required[@]}"; do
  if [[ -z "${!variable:-}" ]]; then
    printf 'Live acceptance remains open: %s is missing.\n' "$variable" >&2
    exit 2
  fi
done

nixctl() {
  node --experimental-strip-types "$repo_root/apps/cli/src/index.ts" --json "$@"
}
run() {
  local output="$1"
  shift
  {
    printf '$ nixctl'
    printf ' %q' "$@"
    printf '\n'
  } >> "$transcript"
  if nixctl "$@" > "$output" 2> "$report_dir/stderr.txt"; then
    cat "$output" >> "$transcript"
    printf '\n' >> "$transcript"
  else
    cat "$output" >> "$transcript"
    cat "$report_dir/stderr.txt" >> "$transcript"
    cat "$report_dir/stderr.txt" >&2
    return 1
  fi
}
if [[ -n "$build_only_file" ]]; then
  run "$report_dir/fallback-build.json" blueprint build "$build_only_file" --workspace "$WORKSPACE" --yes
  node -e '
    const result = require(process.argv[1]);
    if (result.complete !== true || !result.rootId) throw Error("Fallback blueprint build did not complete");
  ' "$report_dir/fallback-build.json"
  printf 'Fallback build ran live; consult interview, tool approvals, template save, and apply remain open. Report: %s\n' "$transcript"
  exit 2
fi

pet() {
  local output="$1"
  shift
  run "$output" pet --api-url "$NIX_API_URL" --workspace "$WORKSPACE" --pet "$PET" --mode consult "$@"
}
read_pet() {
  pet "$report_dir/pet-read.json" read
}
pending_id() {
  node -e '
    const fs = require("node:fs");
    const runtime = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const tool of runtime.tools ?? []) {
      if (tool.status !== "pending") continue;
      try {
        if (JSON.parse(tool.arguments).operation === process.argv[2]) {
          process.stdout.write(tool.id);
          break;
        }
      } catch {}
    }
  ' "$report_dir/pet-read.json" "$1"
}
wait_tool() {
  local operation="$1"
  local deadline=$((SECONDS + 45))
  local id
  while ((SECONDS < deadline)); do
    read_pet
    id="$(pending_id "$operation")"
    if [[ -n "$id" ]]; then
      printf '%s' "$id"
      return 0
    fi
    sleep 3
  done
  return 1
}
find_tool_with_replies() {
  local operation="$1"
  local id
  if id="$(wait_tool "$operation")"; then
    printf '%s' "$id"
    return 0
  fi
  local reply
  for reply in \
    'I want to track each application, its company, stage, next follow-up date, and contacts.' \
    'Please include a board to see application stages and a calendar for follow-up dates.' \
    'Include a few clearly marked sample applications; keep the real tracker blank.'; do
    reply_count="$(cat "$report_dir/reply-count.txt")"
    if ((reply_count >= 3)); then
      break
    fi
    reply_count=$((reply_count + 1))
    printf '%s' "$reply_count" > "$report_dir/reply-count.txt"
    pet "$report_dir/interview-$reply_count.json" send --workspace-tools --message "$reply"
    if id="$(wait_tool "$operation")"; then
      printf '%s' "$id"
      return 0
    fi
  done
  printf 'No pending %s tool after three fixed interview replies. See %s.\n' "$operation" "$transcript" >&2
  return 1
}
preview_tool() {
  local id="$1"
  local output="$2"
  pet "$output" tools run "$id"
  node -e '
    const fs = require("node:fs");
    const result = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const preview = result.preview ?? result;
    if (!preview || !Array.isArray(preview.problems) || preview.problems.length) {
      throw new Error(`Tool preview is missing or refused: ${JSON.stringify(preview)}`);
    }
    process.stdout.write(`${preview.headline}\n`);
  ' "$output"
}
approve_tool() {
  local id="$1"
  local output="$2"
  pet "$output" tools run "$id" --approve
}

printf 0 > "$report_dir/reply-count.txt"
pet "$report_dir/initial-send.json" send --workspace-tools --message \
  'I am job hunting and keep losing track of applications, contacts and follow-ups. Help me design a tracker before making it.'
list_id="$(find_tool_with_replies list_templates)"
preview_tool "$list_id" "$report_dir/list-preview.json"
approve_tool "$list_id" "$report_dir/list-result.json"
validate_id="$(find_tool_with_replies validate_blueprint)"
preview_tool "$validate_id" "$report_dir/validate-preview.json"
approve_tool "$validate_id" "$report_dir/validate-result.json"
node -e '
  const fs = require("node:fs");
  const result = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const tool = result.tools?.find(x => x.id === process.argv[2]);
  if (!tool || tool.status !== "completed") throw Error("Validation tool did not complete");
  const report = JSON.parse(tool.result);
  if (report.ok !== true) throw Error(`Blueprint validation failed: ${JSON.stringify(report.problems)}`);
' "$report_dir/validate-result.json" "$validate_id"

build_id="$(find_tool_with_replies build_blueprint)"
preview_tool "$build_id" "$report_dir/build-preview.json"
approve_tool "$build_id" "$report_dir/build-result.json"

# Derive the model's planned root title from the exact approved tool arguments.
read_pet
node -e '
  const fs = require("node:fs");
  const runtime = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const tool = runtime.tools?.find((entry) => entry.id === process.argv[2]);
  if (!tool) throw new Error("Approved build tool is absent from the runtime receipt.");
  const args = JSON.parse(tool.arguments);
  const spec = JSON.parse(args.specJson);
  fs.writeFileSync(process.argv[3], spec.root?.title ?? spec.title);
' "$report_dir/pet-read.json" "$build_id" "$report_dir/blueprint-title.txt"
blueprint_title="$(cat "$report_dir/blueprint-title.txt")"
run "$report_dir/workspace-roots.json" item ls --workspace "$WORKSPACE"
sandbox_id="$(node -e 'const rows=require(process.argv[1]).items ?? [];const item=rows.find(x=>x.title==="Pet drafts");if(!item)throw Error("Pet drafts missing");process.stdout.write(item.id)' "$report_dir/workspace-roots.json")"
run "$report_dir/draft-children.json" item ls --workspace "$WORKSPACE" --parent "$sandbox_id"
root_id="$(node -e 'const rows=require(process.argv[1]).items ?? [];const item=rows.find(x=>x.title===process.argv[2]);if(!item)throw Error("Blueprint root missing under Pet drafts");process.stdout.write(item.id)' "$report_dir/draft-children.json" "$blueprint_title")"
run "$report_dir/views.json" views get "$root_id"
run "$report_dir/schema.json" schema get "$root_id"
# Inspect the built subtree because samples may sit under an Applications container.
queue=("$root_id")
sample_found=0
node_count=0
while ((${#queue[@]} > 0)); do
  parent="${queue[0]}"
  queue=("${queue[@]:1}")
  node_count=$((node_count + 1))
  if ((node_count > 80)); then
    printf 'Built tree exceeded the 80-node inspection bound.\n' >&2
    exit 1
  fi
  children_file="$report_dir/tree-$node_count.json"
  run "$children_file" item ls --workspace "$WORKSPACE" --parent "$parent"
  if node -e 'const rows=require(process.argv[1]).items ?? [];process.exit(rows.some(x=>x.title.startsWith("Sample: "))?0:1)' "$children_file"; then
    sample_found=1
  fi
  while IFS= read -r child_id; do
    [[ -n "$child_id" ]] && queue+=("$child_id")
  done < <(node -e 'for(const item of require(process.argv[1]).items ?? [])process.stdout.write(`${item.id}\n`)' "$children_file")
done
node -e '
  const fs=require("node:fs");
  const views=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  const schema=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
  if (!views.views?.length) throw Error("Built root has no views");
  if (!schema.properties?.length) throw Error("Built root has no fields");
' "$report_dir/views.json" "$report_dir/schema.json"
if ((sample_found == 0)); then
  printf 'Built tree has no Sample: child.\n' >&2
  exit 1
fi

pet "$report_dir/save-send.json" send --workspace-tools --message 'Save this as a template called Job hunt.'
save_id="$(find_tool_with_replies save_as_template)"
preview_tool "$save_id" "$report_dir/save-preview.json"
approve_tool "$save_id" "$report_dir/save-result.json"
run "$report_dir/templates.json" template list "$WORKSPACE"
template_id="$(node -e 'const rows=require(process.argv[1]).templates ?? [];const item=rows.find(x=>x.title==="Job hunt");if(!item)throw Error("Job hunt template missing");process.stdout.write(item.id)' "$report_dir/templates.json")"
run "$report_dir/applied.json" template apply "$template_id" --mode create --parent "$sandbox_id" --title 'Job hunt 2'
run "$report_dir/draft-children-after-apply.json" item ls --workspace "$WORKSPACE" --parent "$sandbox_id"
node -e 'const rows=require(process.argv[1]).items ?? [];if(!rows.some(x=>x.title==="Job hunt 2"))throw Error("Applied Job hunt 2 tree missing")' "$report_dir/draft-children-after-apply.json"
printf 'D.6 live consult-to-template acceptance passed. Commands and outputs: %s\n' "$transcript"
