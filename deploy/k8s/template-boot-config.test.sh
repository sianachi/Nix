#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
source "$script_dir/template-boot-config.sh"

if (unset TEMPLATE_BOOT_WORKSPACE_ID TEMPLATE_BOOT_OIDC_AUDIENCE TEMPLATE_BOOT_PVC \
  TEMPLATE_BOOT_SERVICE_KEY_SECRET; require_template_boot_config) 2>/dev/null; then
  echo "missing managed-template configuration was accepted" >&2
  exit 1
fi

TEMPLATE_BOOT_WORKSPACE_ID=11111111-1111-4111-8111-111111111111
TEMPLATE_BOOT_OIDC_AUDIENCE=project-id
TEMPLATE_BOOT_PVC=template-files
TEMPLATE_BOOT_SERVICE_KEY_SECRET=template-key
unset TEMPLATE_BOOT_OIDC_SCOPE
require_template_boot_config
[ "$TEMPLATE_BOOT_OIDC_SCOPE" = \
  "openid urn:zitadel:iam:org:project:id:project-id:aud" ]

echo "template boot configuration self-test passed"
