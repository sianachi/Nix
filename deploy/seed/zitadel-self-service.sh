#!/usr/bin/env bash
# Converge a Zitadel instance on the self-service account settings Nix relies on:
#
#   - an active SMTP provider, without which "Forgot password" and email verification never send
#   - an instance login policy that shows password reset and allows passkeys (passwordless)
#
# Nix links people to the provider's own account page (Nix__Bff__AccountPage) for password,
# passkey and second-factor changes; this script makes the provider's side of that work. It is
# instance-agnostic: deploy/seed/zitadel-configure.sh runs it against the development stack with
# Mailpit, and an operator runs it against production with the real mail provider.
#
# Idempotent: the SMTP provider is found by its description and updated only when it differs,
# and the login policy is written only when a field this script owns is wrong.
#
# Required:
#   ZITADEL_URL            the instance origin, e.g. https://sso.example.org
#   ZITADEL_PAT_FILE       a file holding an IAM_OWNER personal access token
# SMTP (all optional; without NIX_SMTP_HOST the SMTP step is skipped and reported):
#   NIX_SMTP_HOST          host:port, e.g. smtp.example.org:587
#   NIX_SMTP_SENDER        sender address, e.g. no-reply@example.org
#   NIX_SMTP_SENDER_NAME   display name (default: Nix)
#   NIX_SMTP_USER          SMTP username (default: none)
#   NIX_SMTP_PASSWORD_FILE a file holding the SMTP password (default: none)
#   NIX_SMTP_TLS           true or false (default: true)
#   NIX_SMTP_REPLY_TO      reply-to address (default: none)
#
# Secrets are read from files and passed to curl through a private header file and stdin, so
# neither the token nor the SMTP password appears in the process table.
#
# Usage:
#   ZITADEL_URL=https://sso.example.org ZITADEL_PAT_FILE=~/zitadel-owner.pat \
#   NIX_SMTP_HOST=smtp.example.org:587 NIX_SMTP_SENDER=no-reply@example.org \
#   NIX_SMTP_USER=apikey NIX_SMTP_PASSWORD_FILE=~/smtp.password \
#     deploy/seed/zitadel-self-service.sh
set -euo pipefail

log() { echo "zitadel-self-service: $*"; }
fail() { echo "zitadel-self-service: $*" >&2; exit 1; }

for tool in curl jq; do
  command -v "$tool" >/dev/null 2>&1 || fail "'$tool' is required but not installed"
done

base_url="${ZITADEL_URL:?set ZITADEL_URL to the Zitadel instance origin}"
base_url="${base_url%/}"
# The token and SMTP password must never cross the network in cleartext: https, or http to this
# machine only - the same rule Core applies to its own origins.
case "$base_url" in
  https://*|http://localhost|http://localhost:*|http://127.0.0.1|http://127.0.0.1:*|http://\[::1\]|http://\[::1\]:*) ;;
  *) fail "ZITADEL_URL must be https (or http to localhost): $base_url" ;;
esac
pat_file="${ZITADEL_PAT_FILE:?set ZITADEL_PAT_FILE to a file holding an IAM_OWNER token}"
[ -r "$pat_file" ] || fail "cannot read ZITADEL_PAT_FILE ($pat_file)"

description="nix-self-service"
smtp_host="${NIX_SMTP_HOST:-}"
smtp_sender="${NIX_SMTP_SENDER:-}"
smtp_sender_name="${NIX_SMTP_SENDER_NAME:-Nix}"
smtp_user="${NIX_SMTP_USER:-}"
smtp_password_file="${NIX_SMTP_PASSWORD_FILE:-}"
smtp_tls="${NIX_SMTP_TLS:-true}"
smtp_reply_to="${NIX_SMTP_REPLY_TO:-}"
case "$smtp_tls" in true|false) ;; *) fail "NIX_SMTP_TLS must be true or false" ;; esac

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
chmod 700 "$work"
headers="$work/headers"
( umask 077
  printf 'Authorization: Bearer %s\n' "$(tr -d '\r\n' < "$pat_file")" > "$headers"
  printf 'Content-Type: application/json\n' >> "$headers" )

api() {
  # api <method> <path> [json-body]; the body travels on stdin, never in argv.
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    printf '%s' "$body" | curl -fsS -X "$method" "$base_url$path" -H @"$headers" --data-binary @-
  else
    curl -fsS -X "$method" "$base_url$path" -H @"$headers"
  fi
}

# ── SMTP provider ───────────────────────────────────────────────────────────
configure_smtp() {
  if [ -z "$smtp_host" ]; then
    local active
    active="$(api POST /admin/v1/email/_search '{}' \
      | jq -r '[.result[]? | select(.state == "EMAIL_PROVIDER_ACTIVE")] | length')"
    if [ "$active" = "0" ]; then
      log "WARNING: no NIX_SMTP_HOST given and no active SMTP provider;"
      log "  password reset and email verification will not send mail"
    else
      log "no NIX_SMTP_HOST given; leaving the existing active SMTP provider as it is"
    fi
    return
  fi
  [ -n "$smtp_sender" ] || fail "NIX_SMTP_SENDER is required with NIX_SMTP_HOST"

  # The password is read by jq itself (--rawfile), never held in a shell variable or passed as an
  # argument, so it cannot appear in the process table.
  if [ -n "$smtp_password_file" ]; then
    [ -r "$smtp_password_file" ] || fail "cannot read NIX_SMTP_PASSWORD_FILE ($smtp_password_file)"
  fi
  with_password() {
    if [ -n "$smtp_password_file" ]; then
      jq -c --rawfile p "$smtp_password_file" '. + {password: ($p | rtrimstr("\n") | rtrimstr("\r"))}'
    else
      jq -c .
    fi
  }

  local wanted
  wanted="$(jq -nc \
    --arg description "$description" \
    --arg host "$smtp_host" \
    --arg sender "$smtp_sender" \
    --arg name "$smtp_sender_name" \
    --arg user "$smtp_user" \
    --arg reply "$smtp_reply_to" \
    --argjson tls "$smtp_tls" \
    '{description:$description, host:$host, senderAddress:$sender, senderName:$name,
      user:$user, replyToAddress:$reply, tls:$tls}')"

  local existing id
  existing="$(api POST /admin/v1/email/_search '{}' \
    | jq -c --arg d "$description" 'first(.result[]? | select(.description == $d)) // empty')"
  id=""
  if [ -n "$existing" ]; then id="$(jq -r '.id // empty' <<<"$existing")"; fi

  if [ -z "$id" ]; then
    id="$(api POST /admin/v1/email/smtp "$(with_password <<<"$wanted")" | jq -r '.id')"
    [ -n "$id" ] && [ "$id" != null ] || fail "Zitadel did not return the new SMTP provider id"
    log "created SMTP provider '$description' ($smtp_host)"
  else
    # Zitadel answers an update that changes nothing with an error, so compare first. Omitting the
    # password from an update keeps the stored one.
    local have
    have="$(jq -c '.smtp | {host, senderAddress, senderName, user:(.user // ""),
      replyToAddress:(.replyToAddress // ""), tls:(.tls // false)}' <<<"$existing")"
    if [ "$have" != "$(jq -c 'del(.description)' <<<"$wanted")" ]; then
      api PUT "/admin/v1/email/smtp/$id" "$wanted" >/dev/null
      log "updated SMTP provider '$description' ($smtp_host)"
    else
      log "SMTP provider '$description' already matches ($smtp_host)"
    fi
    # Never send a password inside the general update: Zitadel v4.16.1 cannot project a
    # config.changed event that carries one ("multiple assignments to same column password"),
    # skips it after five retries, and the read model - which is what sends mail - silently keeps
    # the old host and user. The dedicated password endpoint projects cleanly. The password is
    # write-only and cannot be compared, so supplying one always rewrites it.
    if [ -n "$smtp_password_file" ]; then
      api PUT "/admin/v1/email/smtp/$id/password" \
        "$(jq -nc --rawfile p "$smtp_password_file" '{password: ($p | rtrimstr("\n") | rtrimstr("\r"))}')" \
        >/dev/null
      log "set the SMTP provider password"
    fi
  fi

  local state
  state="$(api POST /admin/v1/email/_search '{}' \
    | jq -r --arg id "$id" 'first(.result[]? | select(.id == $id) | .state) // empty')"
  if [ "$state" = EMAIL_PROVIDER_ACTIVE ]; then
    log "SMTP provider is active"
  else
    api POST "/admin/v1/email/$id/_activate" '{}' >/dev/null
    log "activated SMTP provider '$description'"
  fi

  # Mail is sent from Zitadel's read model, which a failed projection leaves stale without any
  # API error. Prove the settings written here are the ones Zitadel will actually use.
  local want_seen seen="" attempt
  want_seen="$(jq -c '{host, user}' <<<"$wanted")"
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    seen="$(api POST /admin/v1/email/_search '{}' | jq -c --arg id "$id" \
      'first(.result[]? | select(.id == $id and .state == "EMAIL_PROVIDER_ACTIVE")
        | {host: .smtp.host, user: (.smtp.user // "")}) // empty')"
    [ "$seen" = "$want_seen" ] && break
    sleep 1
  done
  if [ "$seen" != "$want_seen" ]; then
    fail "Zitadel accepted the SMTP settings but does not report them active (saw ${seen:-nothing});
  check 'projections.failed_events2' for smtp_configs errors before relying on password reset"
  fi
  log "Zitadel reports the SMTP provider active at $smtp_host"
}

# ── Login policy ────────────────────────────────────────────────────────────
configure_login_policy() {
  local policy
  policy="$(api GET /admin/v1/policies/login | jq -c '.policy')"
  if jq -e '.passwordlessType == "PASSWORDLESS_TYPE_ALLOWED" and ((.hidePasswordReset // false) == false)' \
    <<<"$policy" >/dev/null; then
    log "instance login policy already allows passkeys and shows password reset"
  else
    # The update takes the policy's own fields; factor lists and bookkeeping are separate APIs.
    api PUT /admin/v1/policies/login "$(jq -c '
      del(.details, .isDefault, .secondFactors, .multiFactors, .idps)
      | .passwordlessType = "PASSWORDLESS_TYPE_ALLOWED"
      | .hidePasswordReset = false' <<<"$policy")" >/dev/null
    log "instance login policy now allows passkeys and shows password reset"
  fi

  # An organisation can carry its own policy that overrides the instance default. Changing an
  # organisation's policy is its administrators' decision, so this only reports a contradiction.
  local org
  org="$(api GET /management/v1/policies/login | jq -c '.policy')"
  if jq -e '(.isDefault // false) == false' <<<"$org" >/dev/null \
    && ! jq -e '.passwordlessType == "PASSWORDLESS_TYPE_ALLOWED" and ((.hidePasswordReset // false) == false)' \
      <<<"$org" >/dev/null; then
    log "WARNING: this token's organisation has its own login policy that disables passkeys or"
    log "  hides password reset; it overrides the instance default for that organisation's users"
  fi
}

log "converging $base_url"
configure_smtp
configure_login_policy
log "complete"
