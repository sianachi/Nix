#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
source "$script_dir/zitadel-machine.sh"

calls=0
api() {
  [ "$1" = "PUT" ]
  [ "$2" = "/management/v1/users/machine-user/machine" ]
  [ "$3" = '{"accessTokenType":"ACCESS_TOKEN_TYPE_JWT"}' ]
  calls=$((calls + 1))
}

ensure_machine_jwt_access_token \
  '{"machine":{"accessTokenType":"ACCESS_TOKEN_TYPE_JWT"}}' \
  machine-user
[ "$calls" -eq 0 ]

ensure_machine_jwt_access_token \
  '{"machine":{"accessTokenType":"ACCESS_TOKEN_TYPE_BEARER"}}' \
  machine-user
[ "$calls" -eq 1 ]

[ "$(template_boot_key_action machine-user machine-user false)" = reuse ]
[ "$(template_boot_key_action machine-user machine-user true)" = rotate ]
[ "$(template_boot_key_action old-user machine-user false)" = create ]
if template_boot_key_action machine-user machine-user invalid >/dev/null 2>&1; then
  echo "invalid key rotation configuration was accepted" >&2
  exit 1
fi

test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT
installed_key_file="$test_dir/installed.json"
new_key_file="$test_dir/new.json"
journal_file="$test_dir/rotation.json"
old_key_file="$test_dir/old.json"
jq -n '{type:"serviceaccount",userId:"machine-user",keyId:"old-key-id",key:"old-private"}' > "$old_key_file"
jq -n '{type:"serviceaccount",userId:"machine-user",keyId:"new-key-id",key:"new-private"}' > "$new_key_file"

remote_old_present=false
remote_new_present=false
remote_orphan_present=false
delete_attempts=0
fail_delete=false
delete_machine_key_if_present() {
  local user_id="$1" key_id="$2"
  [ "$user_id" = machine-user ]
  delete_attempts=$((delete_attempts + 1))
  if [ "$fail_delete" = true ]; then
    return 1
  fi
  case "$key_id" in
    old-key-id) remote_old_present=false ;;
    new-key-id) remote_new_present=false ;;
    orphan-key-id) remote_orphan_present=false ;;
    *) return 2 ;;
  esac
}
list_machine_key_ids() {
  [ "$1" = machine-user ]
  [ "$remote_old_present" = true ] && echo old-key-id
  [ "$remote_new_present" = true ] && echo new-key-id
  [ "$remote_orphan_present" = true ] && echo orphan-key-id
  return 0
}

reset_rotation() {
  cp "$old_key_file" "$installed_key_file"
  rm -f "$journal_file" "${journal_file}.tmp" "${installed_key_file}.tmp"
  remote_old_present=true
  remote_new_present=true
  remote_orphan_present=false
  delete_attempts=0
  fail_delete=false
  begin_machine_key_rotation "$journal_file" machine-user old-key-id "$new_key_file"
}

assert_converged() {
  [ "$(jq -r '.keyId' "$installed_key_file")" = new-key-id ]
  [ ! -f "$journal_file" ]
  [ ! -f "${journal_file}.tmp" ]
  [ ! -f "${installed_key_file}.tmp" ]
  [ "$remote_old_present" = false ]
  [ "$remote_new_present" = true ]
  [ "$remote_orphan_present" = false ]
}

# Interrupted after the create response was journaled, before installing the credential.
reset_rotation
converge_machine_key_rotation "$journal_file" "$installed_key_file" >/dev/null
assert_converged

# Interrupted after persisting the API credential, before creating the journal. Startup can build
# the journal from that deterministic private tempfile and then remove it.
reset_rotation
rm -f "$journal_file"
pending_key_file="$test_dir/pending-private.json"
cp "$new_key_file" "$pending_key_file"
begin_machine_key_rotation "$journal_file" machine-user old-key-id "$pending_key_file"
rm -f "$pending_key_file"
converge_machine_key_rotation "$journal_file" "$installed_key_file" >/dev/null
assert_converged
[ ! -f "$pending_key_file" ]

# Interrupted after the atomic credential install, before advancing the journal phase.
reset_rotation
cp "$new_key_file" "$installed_key_file"
converge_machine_key_rotation "$journal_file" "$installed_key_file" >/dev/null
assert_converged

# Interrupted after the phase advance, before the remote DELETE.
reset_rotation
cp "$new_key_file" "$installed_key_file"
set_machine_key_rotation_phase "$journal_file" new-installed
converge_machine_key_rotation "$journal_file" "$installed_key_file" >/dev/null
assert_converged

# Interrupted after remote deletion, before recording it. Idempotent absence must converge.
reset_rotation
cp "$new_key_file" "$installed_key_file"
set_machine_key_rotation_phase "$journal_file" new-installed
remote_old_present=false
converge_machine_key_rotation "$journal_file" "$installed_key_file" >/dev/null
assert_converged

# A failed DELETE retains a recoverable journal, keeps the new credential installed, and retries.
reset_rotation
fail_delete=false
fail_delete=true
if converge_machine_key_rotation "$journal_file" "$installed_key_file" >/dev/null 2>&1; then
  echo "failed key revocation unexpectedly completed the journal" >&2
  exit 1
fi
[ -f "$journal_file" ]
[ "$(jq -r '.phase' "$journal_file")" = new-installed ]
[ "$(jq -r '.keyId' "$installed_key_file")" = new-key-id ]
[ "$remote_old_present" = true ]
[ ! -f "${journal_file}.tmp" ]
[ ! -f "${installed_key_file}.tmp" ]
fail_delete=false
converge_machine_key_rotation "$journal_file" "$installed_key_file" >/dev/null
assert_converged

# A malformed journal can never revoke the credential that is still installed.
reset_rotation
jq '.oldKeyId = .newKeyId' "$journal_file" > "${journal_file}.tmp"
mv "${journal_file}.tmp" "$journal_file"
delete_attempts=0
if converge_machine_key_rotation "$journal_file" "$installed_key_file" >/dev/null 2>&1; then
  echo "rotation with the same old and new key unexpectedly succeeded" >&2
  exit 1
fi
[ "$delete_attempts" -eq 0 ]
[ "$(jq -r '.keyId' "$installed_key_file")" = old-key-id ]

complete_creation_retry() {
  begin_machine_key_creation_intent "$journal_file" machine-user old-key-id
  remote_new_present=true
  record_machine_key_creation "$journal_file" "$new_key_file"
  reconcile_machine_remote_keys machine-user old-key-id new-key-id
  converge_machine_key_rotation "$journal_file" "$installed_key_file" >/dev/null
  assert_converged
}

# POST succeeded but the process died before any response bytes were persisted. Intent plus remote
# discovery removes the unknown orphan without revoking the installed key, then retry converges.
cp "$old_key_file" "$installed_key_file"
rm -f "$journal_file" "${journal_file}.tmp" "${installed_key_file}.tmp"
remote_old_present=true
remote_new_present=false
remote_orphan_present=true
begin_machine_key_creation_intent "$journal_file" machine-user old-key-id
reconcile_machine_remote_keys machine-user old-key-id ""
[ "$remote_old_present" = true ]
[ "$remote_orphan_present" = false ]
rm -f "$journal_file"
complete_creation_retry

# A crash while writing the pending credential leaves only partial private bytes. Recovery removes
# both partial files, reconciles the remote orphan, and installs one newly retried credential.
cp "$old_key_file" "$installed_key_file"
rm -f "$journal_file" "${journal_file}.tmp" "${installed_key_file}.tmp"
remote_old_present=true
remote_new_present=false
remote_orphan_present=true
begin_machine_key_creation_intent "$journal_file" machine-user old-key-id
partial_pending="$test_dir/pending-private.json"
printf '%s' '{"keyId":"partial' > "$partial_pending"
printf '%s' 'private-fragment' > "${partial_pending}.tmp"
rm -f "$partial_pending" "${partial_pending}.tmp"
reconcile_machine_remote_keys machine-user old-key-id ""
[ "$remote_old_present" = true ]
[ "$remote_orphan_present" = false ]
[ ! -f "$partial_pending" ]
[ ! -f "${partial_pending}.tmp" ]
rm -f "$journal_file"
complete_creation_retry

echo "zitadel machine convergence self-test passed"
