#!/usr/bin/env bash

# Journals and atomic tempfiles can contain a service-account private key.
umask 077

# Converges an existing machine user onto JWT access tokens. The caller supplies `api`, the
# authenticated Zitadel request helper used by zitadel-configure.sh.
ensure_machine_jwt_access_token() {
  local machine_json="$1" user_id="$2" current
  current="$(jq -r '.machine.accessTokenType // empty' <<<"$machine_json")"
  if [ "$current" = "ACCESS_TOKEN_TYPE_JWT" ]; then
    return
  fi

  api PUT "/management/v1/users/$user_id/machine" \
    '{"accessTokenType":"ACCESS_TOKEN_TYPE_JWT"}' >/dev/null
  echo "zitadel-configure: re-asserted JWT access tokens for the template boot service account"
}

template_boot_key_action() {
  local existing_user="$1" desired_user="$2" rotate="$3"
  case "$rotate" in
    true|false) ;;
    *) echo "NIX_ZITADEL_ROTATE_TEMPLATE_BOOT_KEY must be true or false" >&2; return 2 ;;
  esac
  if [ "$existing_user" != "$desired_user" ]; then
    echo create
  elif [ "$rotate" = true ]; then
    echo rotate
  else
    echo reuse
  fi
}

# Persists intent before the remote POST. If the response is lost, recovery can identify the old
# installed key as the only protected key and remove every untracked remote orphan before retrying.
begin_machine_key_creation_intent() {
  local journal_file="$1" user_id="$2" old_key_id="$3" journal_tmp
  journal_tmp="${journal_file}.tmp"
  if [ -f "$journal_file" ]; then
    echo "zitadel-configure: a service-account key rotation is already in progress" >&2
    return 2
  fi
  rm -f "$journal_tmp"
  if ! jq -n \
    --arg user_id "$user_id" \
    --arg old_key_id "$old_key_id" \
    '{version:1,phase:"create-intent",userId:$user_id,oldKeyId:$old_key_id,newKeyId:"",credential:null}' \
    > "$journal_tmp"; then
    rm -f "$journal_tmp"
    return 1
  fi
  chmod 600 "$journal_tmp"
  mv "$journal_tmp" "$journal_file"
}

# Atomically attaches the POST response to its pre-existing intent. The journal intentionally
# carries the replacement credential so recovery can install it before touching the old key.
record_machine_key_creation() {
  local journal_file="$1" credential_file="$2" journal_tmp
  journal_tmp="${journal_file}.tmp"
  local phase user_id old_key_id new_key_id credential_user
  phase="$(jq -r '.phase // empty' "$journal_file" 2>/dev/null || true)"
  user_id="$(jq -r '.userId // empty' "$journal_file" 2>/dev/null || true)"
  old_key_id="$(jq -r '.oldKeyId // empty' "$journal_file" 2>/dev/null || true)"
  new_key_id="$(jq -r '.keyId // empty' "$credential_file")"
  credential_user="$(jq -r '.userId // empty' "$credential_file")"
  if [ "$phase" != create-intent ] || [ -z "$user_id" ] || [ -z "$new_key_id" ] \
    || [ "$credential_user" != "$user_id" ] || [ "$new_key_id" = "$old_key_id" ]; then
    echo "zitadel-configure: refusing an invalid service-account key rotation" >&2
    return 2
  fi

  rm -f "$journal_tmp"
  if ! jq -n \
    --arg user_id "$user_id" \
    --arg old_key_id "$old_key_id" \
    --arg new_key_id "$new_key_id" \
    --slurpfile credential "$credential_file" \
    '{version:1,phase:"new-created",userId:$user_id,oldKeyId:$old_key_id,newKeyId:$new_key_id,credential:$credential[0]}' \
    > "$journal_tmp"; then
    rm -f "$journal_tmp"
    return 1
  fi
  chmod 600 "$journal_tmp"
  mv "$journal_tmp" "$journal_file"
}

# Convenience for tests and callers that already hold a complete creation response.
begin_machine_key_rotation() {
  local journal_file="$1" user_id="$2" old_key_id="$3" credential_file="$4"
  begin_machine_key_creation_intent "$journal_file" "$user_id" "$old_key_id"
  record_machine_key_creation "$journal_file" "$credential_file"
}

# The service user is dedicated to boot-managed templates, so exactly the installed key and an
# in-flight journal key may exist. Discovery makes a lost POST response recoverable without ever
# guessing which credential is installed.
reconcile_machine_remote_keys() {
  local user_id="$1" installed_key_id="$2" tracked_key_id="$3" remote_key_ids remote_key_id
  if ! remote_key_ids="$(list_machine_key_ids "$user_id")"; then
    return 1
  fi
  while IFS= read -r remote_key_id; do
    if [ -z "$remote_key_id" ] || [ "$remote_key_id" = "$installed_key_id" ] \
      || { [ -n "$tracked_key_id" ] && [ "$remote_key_id" = "$tracked_key_id" ]; }; then
      continue
    fi
    if ! delete_machine_key_if_present "$user_id" "$remote_key_id"; then
      return 1
    fi
  done <<EOF
$remote_key_ids
EOF
}

set_machine_key_rotation_phase() {
  local journal_file="$1" phase="$2" journal_tmp
  journal_tmp="${journal_file}.tmp"
  rm -f "$journal_tmp"
  if ! jq --arg phase "$phase" '.phase = $phase' "$journal_file" > "$journal_tmp"; then
    rm -f "$journal_tmp"
    return 1
  fi
  chmod 600 "$journal_tmp"
  mv "$journal_tmp" "$journal_file"
}

# Completes or recovers every rotation phase. The caller supplies an idempotent
# delete_machine_key_if_present function that treats an already absent old key as success.
converge_machine_key_rotation() {
  local journal_file="$1" installed_key_file="$2"
  local phase user_id old_key_id new_key_id credential_user credential_key_id
  local installed_key_id install_tmp="${installed_key_file}.tmp"
  if [ ! -f "$journal_file" ]; then
    return
  fi

  phase="$(jq -r '.phase // empty' "$journal_file")"
  user_id="$(jq -r '.userId // empty' "$journal_file")"
  old_key_id="$(jq -r '.oldKeyId // empty' "$journal_file")"
  new_key_id="$(jq -r '.newKeyId // empty' "$journal_file")"
  credential_user="$(jq -r '.credential.userId // empty' "$journal_file")"
  credential_key_id="$(jq -r '.credential.keyId // empty' "$journal_file")"
  case "$phase" in
    new-created|new-installed|old-revoked) ;;
    *) echo "zitadel-configure: the service-account key rotation journal has an invalid phase" >&2; return 2 ;;
  esac
  if [ -z "$user_id" ] || [ -z "$new_key_id" ] \
    || [ "$credential_user" != "$user_id" ] || [ "$credential_key_id" != "$new_key_id" ] \
    || { [ -n "$old_key_id" ] && [ "$old_key_id" = "$new_key_id" ]; }; then
    echo "zitadel-configure: the service-account key rotation journal is invalid" >&2
    return 2
  fi

  installed_key_id="$(jq -r '.keyId // empty' "$installed_key_file" 2>/dev/null || true)"
  if [ "$installed_key_id" != "$new_key_id" ]; then
    rm -f "$install_tmp"
    if ! jq '.credential' "$journal_file" > "$install_tmp"; then
      rm -f "$install_tmp"
      return 1
    fi
    chmod 600 "$install_tmp"
    mv "$install_tmp" "$installed_key_file"
  fi

  installed_key_id="$(jq -r '.keyId // empty' "$installed_key_file" 2>/dev/null || true)"
  if [ "$installed_key_id" != "$new_key_id" ]; then
    echo "zitadel-configure: the replacement service-account key was not installed" >&2
    return 2
  fi
  if [ "$phase" = new-created ]; then
    set_machine_key_rotation_phase "$journal_file" new-installed
    phase=new-installed
  fi

  if [ "$phase" != old-revoked ] && [ -n "$old_key_id" ]; then
    # Re-read immediately before deletion: a stale phase must never revoke the credential that is
    # still installed locally.
    installed_key_id="$(jq -r '.keyId // empty' "$installed_key_file" 2>/dev/null || true)"
    if [ "$installed_key_id" != "$new_key_id" ] || [ "$installed_key_id" = "$old_key_id" ]; then
      echo "zitadel-configure: refusing to revoke the installed service-account key" >&2
      return 2
    fi
    if ! delete_machine_key_if_present "$user_id" "$old_key_id"; then
      return 1
    fi
    set_machine_key_rotation_phase "$journal_file" old-revoked
  fi

  installed_key_id="$(jq -r '.keyId // empty' "$installed_key_file" 2>/dev/null || true)"
  if [ "$installed_key_id" != "$new_key_id" ]; then
    echo "zitadel-configure: replacement service-account key changed during rotation" >&2
    return 2
  fi
  rm -f "$journal_file" "${journal_file}.tmp" "$install_tmp"
  echo "zitadel-configure: converged the template boot service-account key"
}
