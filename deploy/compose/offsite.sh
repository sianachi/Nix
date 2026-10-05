#!/usr/bin/env bash
# Off-host copies of Compose backups in an encrypted restic repository (Cloudflare R2).
#
#   offsite.sh init                                   create the repository; refuses an existing one
#   offsite.sh push <backup-dir> [--tag k=v ...]      upload a directory that passes backup.sh --check
#   offsite.sh snapshots                              list snapshots
#   offsite.sh check [--read-data-subset=N%]          check repository structure, optionally a data sample
#   offsite.sh forget                                 apply retention to release and nightly snapshots
#   offsite.sh restore <snapshot> <empty-target-dir>  extract a snapshot for the isolated restore steps
#
# Credentials live only in NIX_BACKUP_OFFSITE_ENV (default ~/nix-production/backup.env): a
# mode-600 Docker env file holding exactly RESTIC_REPOSITORY, RESTIC_PASSWORD, AWS_ACCESS_KEY_ID,
# AWS_SECRET_ACCESS_KEY and AWS_DEFAULT_REGION. It reaches the restic container through
# --env-file only. This script reads nothing from it but key names, and never prints, sources or
# copies it.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
image='restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510'
host=nix-production
env_keys=(RESTIC_REPOSITORY RESTIC_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION)

die() { echo "offsite: $*" >&2; exit 1; }
usage() {
  echo 'usage: offsite.sh init | push <backup-dir> [--tag k=v ...] | snapshots' >&2
  echo '       | check [--read-data-subset=N%] | forget | restore <snapshot> <empty-target-dir>' >&2
  exit 2
}

file_mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

# Sets env_file after checking ownership, mode and key names. Values are never read into the shell.
env_file=''
load_env_file() {
  local file=${NIX_BACKUP_OFFSITE_ENV:-$HOME/nix-production/backup.env} mode line key seen=' '
  [[ $file == /* ]] || die "NIX_BACKUP_OFFSITE_ENV must be an absolute path: $file"
  [[ -f $file && ! -L $file ]] || die "credentials file not found or not a regular file: $file"
  [[ -O $file ]] || die "credentials file is not owned by the current user: $file"
  mode=$(file_mode "$file")
  [[ $mode =~ ^[0-7]+$ ]] && (( (8#$mode & 8#077) == 0 )) \
    || die "credentials file is readable by group or others (mode $mode); run chmod 600 $file"
  # awk prints only key names, an empty-value marker, or the number of a malformed line.
  while IFS= read -r line; do
    case $line in
      line:*) die "credentials file line ${line#line:} is not KEY=value" ;;
      *:empty) die "credentials file sets ${line%:empty} to an empty value" ;;
    esac
    key=$line
    [[ " ${env_keys[*]} " == *" $key "* ]] || die "credentials file has unexpected key $key"
    [[ $seen != *" $key "* ]] || die "credentials file sets $key more than once"
    seen+="$key "
  done < <(awk '
    /^[[:space:]]*(#|$)/ { next }
    match($0, /^[A-Za-z_][A-Za-z0-9_]*=/) {
      key = substr($0, 1, RLENGTH - 1)
      print (length($0) == RLENGTH ? key ":empty" : key)
      next
    }
    { print "line:" NR }' "$file")
  for key in "${env_keys[@]}"; do
    [[ $seen == *" $key "* ]] || die "credentials file does not set $key"
  done
  env_file=$file
}

# restic_run [docker options ...] -- restic arguments ...
# Hardened as in scripts/backup-r2.py: read-only root, no capabilities beyond reading files,
# private tmpfs for temporary packs and the cache, the default bridge network only.
restic_run() {
  local options=()
  while [[ $1 != -- ]]; do options+=("$1"); shift; done
  shift
  docker run --rm --read-only --cap-drop=ALL --cap-add=DAC_READ_SEARCH \
    --security-opt=no-new-privileges:true --network bridge --memory=1g --pids-limit=256 \
    --tmpfs /tmp:rw,noexec,nosuid,size=256m \
    --tmpfs /cache:rw,noexec,nosuid,size=256m,mode=0700 \
    --env-file "$env_file" \
    ${options[@]+"${options[@]}"} "$image" --cache-dir /cache "$@"
}

cmd_init() {
  [[ $# -eq 0 ]] || usage
  load_env_file
  local status=0 errors
  errors=$(mktemp)
  restic_run -- cat config >/dev/null 2>"$errors" || status=$?
  case $status in
    0) rm -f "$errors"; die 'the repository already exists; refusing to initialize it again' ;;
    10) rm -f "$errors" ;; # restic: repository does not exist
    *) cat "$errors" >&2; rm -f "$errors"; die "could not determine whether the repository exists (restic exit $status)" ;;
  esac
  restic_run -- init
  echo 'offsite: repository initialized. Keep RESTIC_PASSWORD in a password manager; it cannot be recovered.'
}

cmd_push() {
  [[ $# -ge 1 ]] || usage
  local dir=${1%/} name tag tags=() out snapshot
  shift
  while [[ $# -gt 0 ]]; do
    case $1 in
      --tag) [[ $# -ge 2 ]] || usage; tag=$2; shift 2 ;;
      --tag=*) tag=${1#--tag=}; shift ;;
      *) usage ;;
    esac
    [[ $tag =~ ^[a-z][a-z0-9_-]*=[A-Za-z0-9._:-]+$ ]] || die "tag must be key=value without spaces or commas: $tag"
    tags+=(--tag "$tag")
  done
  [[ $dir == /* ]] || die "backup directory must be an absolute path: $dir"
  [[ -d $dir && ! -L $dir ]] || die "backup directory does not exist: $dir"
  [[ $dir != *,* ]] || die "backup directory path may not contain a comma: $dir"
  name=${dir##*/}
  [[ $name =~ ^[A-Za-z0-9._-]+$ ]] || die "unexpected backup directory name: $name"
  bash "$here/backup.sh" --check "$dir" >/dev/null || die "refusing to push $dir: backup.sh --check failed"
  load_env_file
  echo "offsite: pushing $dir"
  out=$(mktemp)
  # JSON output carries the snapshot id; it holds file names and sizes, never credentials.
  if ! restic_run --mount "type=bind,src=$dir,dst=/backup/$name,readonly" -- \
      backup --json --host "$host" ${tags[@]+"${tags[@]}"} "/backup/$name" > "$out"; then
    rm -f "$out"; die "restic backup of $dir failed"
  fi
  snapshot=$(python3 -c '
import json, sys
ids = []
for line in open(sys.argv[1]):
    try:
        message = json.loads(line)
    except ValueError:
        continue
    if isinstance(message, dict) and message.get("message_type") == "summary":
        ids.append(message.get("snapshot_id") or "")
print(ids[-1] if ids else "")' "$out")
  rm -f "$out"
  [[ $snapshot =~ ^[0-9a-f]{8,64}$ ]] || die "restic backup of $dir reported no snapshot id"
  restic_run -- check || die "restic check failed after pushing snapshot $snapshot"
  echo "offsite: snapshot $snapshot"
}

cmd_check() {
  local args=()
  case $# in
    0) ;;
    1) [[ $1 =~ ^--read-data-subset=([1-9][0-9]?|100)%$ ]] || usage; args=("$1") ;;
    *) usage ;;
  esac
  load_env_file
  restic_run -- check ${args[@]+"${args[@]}"}
}

# Each kind tag is its own retention group, so a release snapshot never counts against nightly
# retention or the reverse. Snapshots without a kind tag are never forgotten.
cmd_forget() {
  [[ $# -eq 0 ]] || usage
  load_env_file
  restic_run -- forget --host "$host" --tag kind=release --group-by host --keep-last 10 --prune
  restic_run -- forget --host "$host" --tag kind=nightly --group-by host \
    --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
}

cmd_restore() {
  [[ $# -eq 2 ]] || usage
  local snapshot=$1 target=${2%/} restored
  [[ $snapshot == latest || $snapshot =~ ^[0-9a-f]{8,64}$ ]] || die "not a snapshot id: $snapshot"
  [[ $target == /* ]] || die "restore target must be an absolute path: $target"
  [[ $target != *,* ]] || die "restore target may not contain a comma: $target"
  if [[ -e $target || -L $target ]]; then
    [[ -d $target && ! -L $target ]] || die "restore target is not a directory: $target"
    [[ -z $(ls -A "$target") ]] || die "restore target is not empty: $target"
  else
    mkdir -m 700 "$target"
  fi
  load_env_file
  # Restoring ownership and modes needs the file-owner capabilities; nothing else is added.
  restic_run --cap-add=CHOWN --cap-add=FOWNER --cap-add=DAC_OVERRIDE \
    --mount "type=bind,src=$target,dst=/restore" -- \
    restore "$snapshot" --host "$host" --target /restore --verify
  # restic runs as root in its container, so the directories it creates above the snapshot's
  # own files (backup/) are root-owned and the operator could not remove the restore afterwards.
  # Hand the whole target to the invoking user, from the same image, with no network and only
  # the capabilities chown needs: CHOWN, and DAC_READ_SEARCH to enter the mode-700 target.
  docker run --rm --read-only --network none --cap-drop=ALL --cap-add=CHOWN --cap-add=DAC_READ_SEARCH \
    --security-opt=no-new-privileges:true --entrypoint /bin/chown \
    --mount "type=bind,src=$target,dst=/restore" "$image" -R "$(id -u):$(id -g)" /restore
  echo "offsite: restored $snapshot into $target"
  for restored in "$target"/backup/*; do
    [[ -d $restored ]] && echo "offsite: verify it with: bash $here/backup.sh --check $restored"
  done
  return 0
}

command -v docker >/dev/null || die 'docker is required'
umask 077
[[ $# -ge 1 ]] || usage
action=$1
shift
case $action in
  init) cmd_init "$@" ;;
  push) cmd_push "$@" ;;
  snapshots) [[ $# -eq 0 ]] || usage; load_env_file; restic_run -- snapshots ;;
  check) cmd_check "$@" ;;
  forget) cmd_forget "$@" ;;
  restore) cmd_restore "$@" ;;
  -h|--help) usage ;;
  *) usage ;;
esac
