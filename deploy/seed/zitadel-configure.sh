#!/usr/bin/env bash
# Configure the development Zitadel instance to the credentials this repo
# expects, so the IdP is reproducible instead of hand-clicked through the
# console.
#
# Idempotent: every object is looked up by name first and only created when
# absent, so running this repeatedly converges rather than duplicating.
#
# What it creates, inside the first-instance org:
#   - a project, NIX_ZITADEL_PROJECT_NAME
#   - a user-agent (SPA) OIDC application for the web app, PKCE, no secret,
#     with the dev redirect URIs. Its generated client ID is written out.
#   - a developer human user with the credentials specified in .env, so tests
#     and manual sign-in always have a known account.
#
# Outputs deploy/.zitadel/oidc.generated.env: issuer, client ID and the dev
# user's credentials, for the API and web app to consume. That file is
# gitignored - it is generated, machine-specific state, not source.
#
# Usage (from anywhere, with the core profile up):
#   deploy/seed/zitadel-configure.sh
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
deploy_dir="$(cd "$script_dir/.." && pwd)"
compose_file="$deploy_dir/compose.dev.yml"
out_dir="$deploy_dir/.zitadel"
out_file="$out_dir/oidc.generated.env"

zitadel_port="${ZITADEL_PORT:-8300}"
base_url="http://localhost:${zitadel_port}"

project_name="${NIX_ZITADEL_PROJECT_NAME:-Nix}"
app_name="${NIX_ZITADEL_APP_NAME:-Nix Web}"
web_origin="${NIX_WEB_ORIGIN:-http://localhost:5173}"

dev_username="${NIX_ZITADEL_DEV_USERNAME:-dev@nix.localhost}"
dev_password="${NIX_ZITADEL_DEV_PASSWORD:-NixDev-Password1!}"
dev_given_name="${NIX_ZITADEL_DEV_GIVEN_NAME:-Nix}"
dev_family_name="${NIX_ZITADEL_DEV_FAMILY_NAME:-Developer}"
dev_email="${NIX_ZITADEL_DEV_EMAIL:-dev@nix.localhost}"

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "zitadel-configure: '$1' is required but not installed" >&2
    exit 1
  }
}
require curl
require jq

# ── Wait for Zitadel to serve discovery ─────────────────────────────────────
echo "zitadel-configure: waiting for $base_url to serve OIDC discovery"
deadline=$((SECONDS + 180))
until curl -fsS -o /dev/null "$base_url/.well-known/openid-configuration" 2>/dev/null; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "zitadel-configure: Zitadel did not become ready within 180s" >&2
    echo "zitadel-configure: check 'docker compose -f $compose_file logs zitadel'" >&2
    exit 1
  fi
  sleep 3
done
echo "zitadel-configure: Zitadel is serving"

# ── Read the bootstrap PAT ──────────────────────────────────────────────────
# Written by the first-instance bootstrap into the machinekey volume. Read it
# out of the volume rather than the container, which is distroless.
pat="$(docker run --rm \
  -v nix-dev_zitadel-machinekey:/machinekey:ro \
  busybox:1.37 sh -c 'cat /machinekey/pat.txt 2>/dev/null' || true)"
pat="$(printf '%s' "$pat" | tr -d '\r\n')"

if [ -z "$pat" ]; then
  echo "zitadel-configure: no PAT found in the zitadel-machinekey volume." >&2
  echo "zitadel-configure: the first-instance bootstrap writes it on the very" >&2
  echo "  first initialisation only. If this instance predates that bootstrap," >&2
  echo "  recreate it:  docker compose -f $compose_file --profile core down -v" >&2
  exit 1
fi

api() {
  # api <method> <path> [json-body]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -fsS -X "$method" "$base_url$path" \
      -H "Authorization: Bearer $pat" \
      -H 'Content-Type: application/json' \
      -d "$body"
  else
    curl -fsS -X "$method" "$base_url$path" \
      -H "Authorization: Bearer $pat" \
      -H 'Content-Type: application/json'
  fi
}

# ── Instance features ───────────────────────────────────────────────────────
# Turn off the v2 login UI.
#
# A fresh Zitadel instance sets loginV2.required = true, which routes every
# sign-in to /ui/v2/login. That UI is a SEPARATE service shipped as its own
# container, and this compose stack does not run it - so the redirect lands on a
# route with no handler and the browser gets a bare gRPC status:
#
#     /oauth/v2/authorize -> 302 -> /ui/v2/login/login?authRequest=...
#                                -> {"code":5, "message":"Not Found"}
#
# which says nothing about the actual cause. Disabling the flag makes Zitadel
# serve its own built-in login, which is what this stack expects and what the
# registered redirect URIs are for.
#
# The alternative is adding the login-v2 container to compose. That is closer to
# where Zitadel is heading and worth revisiting, but it is another service to
# run and keep in step for a development stack whose whole point is one command.
echo "zitadel-configure: disabling the v2 login UI (no login-v2 service in this stack)"
api PUT /v2/features/instance '{"loginV2":{"required":false}}' >/dev/null
echo "zitadel-configure: instance will use the built-in login"

# ── Project ─────────────────────────────────────────────────────────────────
project_id="$(api POST /management/v1/projects/_search \
  "$(jq -nc --arg n "$project_name" \
    '{queries:[{nameQuery:{name:$n,method:"TEXT_QUERY_METHOD_EQUALS"}}]}')" \
  | jq -r --arg n "$project_name" \
      'first(.result[]? | select(.name == $n) | .id) // empty')"

if [ -n "$project_id" ]; then
  echo "zitadel-configure: project '$project_name' already present ($project_id)"
else
  project_id="$(api POST /management/v1/projects \
    "$(jq -nc --arg n "$project_name" '{name:$n}')" | jq -r '.id')"
  echo "zitadel-configure: created project '$project_name' ($project_id)"
fi

# ── OIDC application (SPA, PKCE, no secret) ─────────────────────────────────
client_id="$(api POST "/management/v1/projects/$project_id/apps/_search" \
  "$(jq -nc '{queries:[]}')" \
  | jq -r --arg n "$app_name" \
      'first(.result[]? | select(.name == $n) | .oidcConfig.clientId) // empty')"

if [ -n "$client_id" ]; then
  echo "zitadel-configure: application '$app_name' already present"
else
  app_payload="$(jq -nc \
    --arg name "$app_name" \
    --arg redirect "$web_origin/auth/callback" \
    --arg logout "$web_origin" \
    '{
      name: $name,
      redirectUris: [$redirect],
      postLogoutRedirectUris: [$logout],
      responseTypes: ["OIDC_RESPONSE_TYPE_CODE"],
      grantTypes: ["OIDC_GRANT_TYPE_AUTHORIZATION_CODE", "OIDC_GRANT_TYPE_REFRESH_TOKEN"],
      appType: "OIDC_APP_TYPE_USER_AGENT",
      authMethodType: "OIDC_AUTH_METHOD_TYPE_NONE",
      devMode: true,
      accessTokenType: "OIDC_TOKEN_TYPE_JWT",
      accessTokenRoleAssertion: false,
      idTokenRoleAssertion: false,
      idTokenUserinfoAssertion: true
    }')"
  # devMode allows the plain-http localhost redirect the dev server uses.
  # Access tokens are JWTs so the API can validate them against JWKS, and role
  # assertion is off on purpose: roles live in the database, never in a token.
  client_id="$(api POST "/management/v1/projects/$project_id/apps/oidc" \
    "$app_payload" | jq -r '.clientId')"
  echo "zitadel-configure: created application '$app_name' (client $client_id)"
fi

# ── Developer human user with specified credentials ─────────────────────────
user_id="$(api POST /v2/users \
  "$(jq -nc --arg u "$dev_username" \
    '{query:{offset:"0",limit:100},queries:[{userNameQuery:{userName:$u,method:"TEXT_QUERY_METHOD_EQUALS"}}]}')" \
  2>/dev/null | jq -r 'first(.result[]?.userId) // empty' || true)"

if [ -n "$user_id" ]; then
  echo "zitadel-configure: developer user '$dev_username' already present"
  # Re-assert the password so rotating it in .env takes effect.
  api POST "/v2/users/$user_id/password" \
    "$(jq -nc --arg p "$dev_password" \
      '{newPassword:{password:$p,changeRequired:false}}')" >/dev/null
  echo "zitadel-configure: reset developer password to the configured value"
else
  user_payload="$(jq -nc \
    --arg u "$dev_username" \
    --arg g "$dev_given_name" \
    --arg f "$dev_family_name" \
    --arg e "$dev_email" \
    --arg p "$dev_password" \
    '{
      username: $u,
      profile: {givenName: $g, familyName: $f},
      email: {email: $e, isVerified: true},
      password: {password: $p, changeRequired: false}
    }')"
  user_id="$(api POST /v2/users/human "$user_payload" | jq -r '.userId')"
  echo "zitadel-configure: created developer user '$dev_username' ($user_id)"
fi

# ── Write the generated configuration ───────────────────────────────────────
mkdir -p "$out_dir"
cat > "$out_file" <<EOF
# Generated by deploy/seed/zitadel-configure.sh. Do not edit; re-run instead.
# Machine-specific state, not source: this file is gitignored.
NIX_OIDC_ISSUER=$base_url
NIX_OIDC_DISCOVERY=$base_url/.well-known/openid-configuration
NIX_OIDC_CLIENT_ID=$client_id
NIX_OIDC_PROJECT_ID=$project_id
NIX_OIDC_REDIRECT_URI=$web_origin/auth/callback
NIX_OIDC_POST_LOGOUT_REDIRECT_URI=$web_origin
NIX_DEV_USERNAME=$dev_username
NIX_DEV_PASSWORD=$dev_password
# The issuer's subject claim for the developer user. seed.sh maps the Acme
# administrator principal onto it, because Core resolves a token's `sub` against
# `principal.external_subject` and refuses a subject nobody provisioned - a token
# alone must never mint an identity.
NIX_DEV_USER_ID=$user_id
EOF

echo
echo "zitadel-configure: complete."
echo "  issuer    : $base_url"
echo "  client ID : $client_id"
echo "  dev login : $dev_username / $dev_password"
echo "  written   : ${out_file#"$(cd "$deploy_dir/.." && pwd)/"}"
echo "zitadel-configure: re-running this script is a no-op."
