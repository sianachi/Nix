#!/usr/bin/env bash

require_template_boot_config() {
  : "${TEMPLATE_BOOT_WORKSPACE_ID:?set TEMPLATE_BOOT_WORKSPACE_ID to the managed-template workspace UUID}"
  : "${TEMPLATE_BOOT_OIDC_AUDIENCE:?set TEMPLATE_BOOT_OIDC_AUDIENCE to the Zitadel project ID}"
  : "${TEMPLATE_BOOT_PVC:?set TEMPLATE_BOOT_PVC to the claim containing managed .nix files}"
  : "${TEMPLATE_BOOT_SERVICE_KEY_SECRET:?set TEMPLATE_BOOT_SERVICE_KEY_SECRET to the secret holding service-account-key.json}"
  TEMPLATE_BOOT_OIDC_SCOPE="${TEMPLATE_BOOT_OIDC_SCOPE:-openid urn:zitadel:iam:org:project:id:${TEMPLATE_BOOT_OIDC_AUDIENCE}:aud}"
  export TEMPLATE_BOOT_WORKSPACE_ID TEMPLATE_BOOT_OIDC_AUDIENCE TEMPLATE_BOOT_OIDC_SCOPE
  export TEMPLATE_BOOT_PVC TEMPLATE_BOOT_SERVICE_KEY_SECRET
}
