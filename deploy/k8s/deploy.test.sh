#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

fake_bin="$test_root/bin"
mkdir -p "$fake_bin"
export KUBECTL_LOG="$test_root/kubectl.log"
export RENDERED_PRESET_JOB="$test_root/template-presets.yaml"
export RENDERED_RABBITMQ="$test_root/rabbitmq.yaml"
export RENDERED_API="$test_root/api.yaml"
export RENDERED_TEMPLATE_SYNC="$test_root/template-sync.yaml"
export RENDERED_WORKERS="$test_root/workers.yaml"
export RENDERED_WEB="$test_root/web.yaml"
export RENDERED_SITES="$test_root/sites.yaml"
export RENDERED_INGRESS="$test_root/ingress.yaml"
export RENDERED_ALL="$test_root/all.yaml"
export RENDERED_ZITADEL="$test_root/zitadel.yaml"

cat > "$fake_bin/git" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = "rev-parse" ] && [ "\${2:-}" = "--show-toplevel" ]; then
  printf '%s\n' '$repo_root'
  exit 0
fi
exit 2
EOF

cat > "$fake_bin/kubectl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ " $* " == *" get statefulset nix-opensearch "* ]]; then
  printf 'get:%s\n' "$*" >> "$KUBECTL_LOG"
  if [ "${FAIL_RETIRED_SEARCH_LOOKUP:-}" = 1 ]; then exit 1; fi
  if [ "${MISSING_RETIRED_SEARCH:-}" != 1 ]; then printf 'statefulset.apps/nix-opensearch'; fi
  exit 0
fi

if [[ " $* " == *" get statefulset nix-loki "* ]]; then
  printf 'get:%s\n' "$*" >> "$KUBECTL_LOG"
  if [ "${FAIL_RETIRED_LOKI_LOOKUP:-}" = 1 ]; then exit 1; fi
  if [ "${MISSING_RETIRED_LOKI:-}" != 1 ]; then printf 'statefulset.apps/nix-loki'; fi
  exit 0
fi

if [[ " $* " == *" patch statefulset nix-loki "* ]]; then
  printf 'kubectl:%s\n' "$*" >> "$KUBECTL_LOG"
  if [ "${FAIL_RETIRED_LOKI_PATCH:-}" = 1 ]; then exit 1; fi
  exit 0
fi

if [[ " $* " == *" get secret nix-rabbitmq "* && " $* " == *"metadata.resourceVersion"* ]]; then
  printf '12345'
  exit 0
fi

if [[ " $* " == *" get secret nix-object-store "* && " $* " == *"metadata.resourceVersion"* ]]; then
  printf '67890'
  exit 0
fi

if [[ " $* " == *" get secret nix-sites "* && " $* " == *"metadata.resourceVersion"* ]]; then
  printf '24680'
  exit 0
fi

if [[ " $* " == *" get secret nix-sites "* && " $* " == *" jsonpath="* ]]; then
  if [ "${MISSING_SITES_KEY:-}" = 1 ] && [[ " $* " == *"read-access-key"* ]]; then exit 0; fi
  printf 'dGVzdA=='
  exit 0
fi

if [[ " $* " == *" get secret nix-rabbitmq "* && " $* " == *" jsonpath="* ]]; then
  printf 'dGVzdA=='
  exit 0
fi

if [[ " $* " == *" get secret nix-object-store "* && " $* " == *" jsonpath="* ]]; then
  printf 'dGVzdA=='
  exit 0
fi

if [[ " $* " == *" apply -f - "* ]]; then
  payload="$(</dev/stdin)"
  printf '%s\n---\n' "$payload" >> "$RENDERED_ALL"
  names="$(printf '%s\n' "$payload" | sed -nE \
    -e 's/^metadata: \{ name: ([^,}]+).*$/\1/p' \
    -e 's/^  name: ([^ ]+)$/\1/p' | paste -sd, -)"
  printf 'apply-stdin:%s\n' "$names" >> "$KUBECTL_LOG"
  if [[ "$payload" == *"nix-template-presets-"* ]]; then
    printf '%s\n' "$payload" > "$RENDERED_PRESET_JOB"
  fi
  if [[ "$payload" == *"kind: StatefulSet"* && "$payload" == *"name: nix-rabbitmq"* ]]; then
    printf '%s\n' "$payload" > "$RENDERED_RABBITMQ"
  fi
  if [[ "$payload" == *"name: nix-api-data-protection"* ]]; then
    printf '%s\n' "$payload" > "$RENDERED_API"
  fi
  if [[ "$payload" == *"name: nix-template-boot-render-order"* ]]; then
    printf '%s\n' "$payload" > "$RENDERED_TEMPLATE_SYNC"
  fi
  if [[ "$payload" == *"kind: Deployment"* && "$payload" == *"name: nix-worker, namespace"* ]]; then
    printf '%s\n' "$payload" > "$RENDERED_WORKERS"
  fi
  if [[ "$payload" == *"name: nix-sites-serve"* && "$payload" == *"kind: Deployment"* ]]; then
    printf '%s\n' "$payload" > "$RENDERED_SITES"
  fi
  if [[ "$payload" == *"name: nix-zitadel-env"* ]]; then
    printf '%s\n' "$payload" > "$RENDERED_ZITADEL"
  fi
  if [[ "$payload" == *"kind: Ingress"* ]]; then
    printf '%s\n' "$payload" > "$RENDERED_INGRESS"
  fi
  if [[ "$payload" == *"name: nix-web"* && "$payload" == *"containerPort: 8090"* ]]; then
    printf '%s\n' "$payload" > "$RENDERED_WEB"
  fi
  exit 0
fi

if [[ " $* " == *" create configmap "* ]]; then
  name=""
  previous=""
  for argument in "$@"; do
    if [ "$previous" = "configmap" ]; then
      name="$argument"
      break
    fi
    previous="$argument"
  done
  printf 'create-configmap:%s\n' "$name" >> "$KUBECTL_LOG"
  printf 'apiVersion: v1\nkind: ConfigMap\nmetadata: { name: %s, namespace: nix }\n' "$name"
  exit 0
fi

case " $* " in
  *" apply -f "*) printf 'apply-file:%s\n' "${!#}" >> "$KUBECTL_LOG" ;;
  *" wait "*) printf 'wait:%s\n' "$*" >> "$KUBECTL_LOG" ;;
  *" rollout status "*) printf 'rollout:%s\n' "$*" >> "$KUBECTL_LOG" ;;
  *" delete "*) printf 'delete:%s\n' "$*" >> "$KUBECTL_LOG" ;;
  *" get "*) printf 'get:%s\n' "$*" >> "$KUBECTL_LOG" ;;
  *) printf 'kubectl:%s\n' "$*" >> "$KUBECTL_LOG" ;;
esac
EOF

chmod +x "$fake_bin/git" "$fake_bin/kubectl"

run_deploy() {
PATH="$fake_bin:$PATH" \
REGISTRY=registry.example.test \
TAG=render-order \
OIDC_ISSUER="${OIDC_ISSUER-https://identity.example.test}" \
OIDC_CLIENT_ID=web-client \
DOMAIN=nix.example.test \
TEMPLATE_BOOT_WORKSPACE_ID=11111111-1111-4111-8111-111111111111 \
TEMPLATE_BOOT_OIDC_AUDIENCE=project-id \
TEMPLATE_BOOT_PVC=template-files \
TEMPLATE_BOOT_SERVICE_KEY_SECRET=template-service-key \
NIX_DEPLOY_TARGET=kubernetes bash "$repo_root/deploy/k8s/deploy.sh" >/dev/null

}
# A first install has no template workspace, Zitadel project or service key yet.
run_first_install() {
PATH="$fake_bin:$PATH" \
REGISTRY=registry.example.test \
TAG=render-order \
OIDC_CLIENT_ID=web-client \
DOMAIN=nix.example.test \
NIX_TEMPLATE_BOOT_ENABLED=false \
NIX_DEPLOY_TARGET=kubernetes bash "$repo_root/deploy/k8s/deploy.sh" >/dev/null
}
run_deploy

line_of() {
  local pattern="$1"
  local line
  line="$(grep -nF "$pattern" "$KUBECTL_LOG" | head -n 1 | cut -d: -f1)"
  if [ -z "$line" ]; then
    echo "deployment did not record: $pattern" >&2
    exit 1
  fi
  printf '%s\n' "$line"
}

assert_before() {
  local earlier="$1"
  local later="$2"
  if [ "$(line_of "$earlier")" -ge "$(line_of "$later")" ]; then
    echo "deployment order is wrong: '$earlier' must precede '$later'" >&2
    exit 1
  fi
}

assert_before \
  "wait:-n nix wait --for=condition=complete job/nix-migrate-documents-render-order" \
  "create-configmap:nix-template-presets"
assert_before \
  "create-configmap:nix-template-presets" \
  "apply-stdin:nix-template-presets-render-order"
assert_before \
  "apply-stdin:nix-template-presets-render-order" \
  "wait:-n nix wait --for=condition=complete job/nix-template-presets-render-order"
assert_before \
  "rollout:-n nix rollout status statefulset/nix-rabbitmq" \
  "apply-stdin:nix-api-data-protection,nix-api,nix-api"
assert_before \
  "wait:-n nix wait --for=condition=complete job/nix-template-presets-render-order" \
  "apply-stdin:nix-api-data-protection,nix-api,nix-api"
assert_before \
  "apply-stdin:nix-api-data-protection,nix-api,nix-api" \
  "rollout:-n nix rollout status deployment/nix-api"

grep -Fq 'name: nix-template-presets-render-order' "$RENDERED_PRESET_JOB"
grep -Fq 'runAsGroup: 999' "$RENDERED_PRESET_JOB"
grep -Fq 'fsGroup: 999' "$RENDERED_PRESET_JOB"
grep -Fq 'automountServiceAccountToken: false' "$RENDERED_PRESET_JOB"
grep -Fq 'configMap: { name: nix-template-presets }' "$RENDERED_PRESET_JOB"
grep -Fq 'name: PGUSER, value: nix_migrator' "$RENDERED_PRESET_JOB"
grep -Fq 'create-configmap:nix-rabbitmq-config' "$KUBECTL_LOG"
grep -Fq 'apply-stdin:nix-rabbitmq,nix-rabbitmq,rabbitmq-ingress' "$KUBECTL_LOG"
grep -Fq 'nix.io/rabbitmq-secret-version: "12345"' "$RENDERED_RABBITMQ"
grep -Fq 'key: api-password' "$RENDERED_RABBITMQ"
grep -Fq 'key: import-password' "$RENDERED_RABBITMQ"
grep -Fq 'key: export-password' "$RENDERED_RABBITMQ"
grep -Fq 'key: plugin-password' "$RENDERED_RABBITMQ"
grep -Fq 'key: calendar-password' "$RENDERED_RABBITMQ"
grep -Fq 'key: notify-password' "$RENDERED_RABBITMQ"
grep -Fq 'nix.io/rabbitmq-secret-version: "12345"' "$RENDERED_API"
test "$(grep -Fc 'nix.io/object-store-secret-version: "67890"' "$RENDERED_API")" -eq 1
grep -Fq 'key: api-url' "$RENDERED_API"
grep -Fq 'name: Nix__ObjectStorage__PublicOrigin' "$RENDERED_API"
grep -Fq 'key: public-origin' "$RENDERED_API"
# Core refuses a plain-HTTP endpoint off loopback, so it never gets the in-cluster one.
grep -A1 -F 'name: Nix__ObjectStorage__Endpoint' "$RENDERED_API" | grep -Fq 'key: public-origin }'
if grep -Eq 'nix-media|/media:' "$KUBECTL_LOG" "$RENDERED_TEMPLATE_SYNC"; then
  echo 'Deployment still references the retired Media service.' >&2
  exit 1
fi
grep -Fq 'image: registry.example.test/collab:render-order' "$RENDERED_TEMPLATE_SYNC"
grep -Fq 'name: NIX_TEMPLATE_BOOT_CORE_URL, value: http://nix-api:8080' "$RENDERED_TEMPLATE_SYNC"
if grep -Fq 'NIX_TEMPLATE_BOOT_MEDIA_URL' "$RENDERED_TEMPLATE_SYNC"; then
  echo 'Template sync still uses the retired Media URL.' >&2
  exit 1
fi
grep -Fq 'nix.io/rabbitmq-secret-version: "12345"' "$RENDERED_WORKERS"
test "$(grep -Fc 'nix.io/object-store-secret-version: "67890"' "$RENDERED_WORKERS")" -eq 1
# One worker Deployment runs every role under the combined broker account.
grep -Fq 'value: import,export,plugin-events,calendar,notify' "$RENDERED_WORKERS"
grep -Fq 'key: worker-url' "$RENDERED_WORKERS"
grep -Fq 'key: worker-password' "$RENDERED_RABBITMQ"
grep -Fq 'values: [nix-worker, nix-sites-worker]' "$RENDERED_RABBITMQ"
grep -Fq 'delete:-n nix delete deployment/nix-import-worker' "$KUBECTL_LOG"
grep -Fq 'rollout:-n nix rollout status deployment/nix-worker ' "$KUBECTL_LOG"
if grep -Eq 'rollout:.*nix-(import|export|plugin|calendar|notify)-worker' "$KUBECTL_LOG"; then
  echo 'Deployment still waits for retired per-role workers.' >&2
  exit 1
fi
grep -Fq 'name: NIX_OBJECT_STORE_PUBLIC_ORIGIN' "$RENDERED_WEB"
grep -Fq 'key: public-origin' "$RENDERED_WEB"
test "$(grep -Fc 'nix.io/object-store-secret-version: "67890"' "$RENDERED_WEB")" -eq 1

# Sites (ADR-0063): own image, broker identity, read-only bucket key, host-routed ingress.
grep -Fq 'image: registry.example.test/sites:render-order' "$RENDERED_SITES"
grep -Fq 'key: sites-url' "$RENDERED_SITES"
grep -Fq 'key: read-access-key' "$RENDERED_SITES"
grep -Fq 'value: "nix.example.test"' "$RENDERED_SITES"
grep -Fq 'nix.io/sites-secret-version: "24680"' "$RENDERED_SITES"
grep -Fq 'command: ["node", "--experimental-strip-types", "src/serve/index.ts"]' "$RENDERED_SITES"
test "$(grep -Fc 'readOnlyRootFilesystem: true' "$RENDERED_SITES")" -eq 2
test "$(grep -Fc 'httpHeaders: [{ name: Host, value: localhost }]' "$RENDERED_SITES")" -eq 2
serve_section="$(sed -n '/name: nix-sites-serve, namespace/,/name: sites-worker-egress/p' "$RENDERED_SITES")"
if printf '%s\n' "$serve_section" | grep -Eq 'nix-internal|nix-connections|nix-rabbitmq|key: access-key|key: secret-key'; then
  echo 'The anonymous sites server received a Core, database, broker or write credential.' >&2
  exit 1
fi
grep -Fq 'key: sites-password' "$RENDERED_RABBITMQ"
grep -Fq 'name: Nix__Sites__Domain' "$RENDERED_API"
grep -Fq 'name: Nix__Sites__SharedAppDomain' "$RENDERED_API"
grep -A1 -F 'name: Nix__Sites__ForeignLabelSuffixes__0' "$RENDERED_API" | grep -Fq 'value: "-home"'
grep -Fq 'key: reserved-owner-nix, optional: true' "$RENDERED_API"
grep -Fq 'hosts: ["nix.example.test", "*.nix.example.test"]' "$RENDERED_INGRESS"
grep -Fq 'host: "*.nix.example.test"' "$RENDERED_INGRESS"
grep -Fq 'service: { name: nix-sites-serve, port: { number: 8400 } }' "$RENDERED_INGRESS"
# Custom hostnames: one host-less rule at the lowest priority, so it never outranks a named host.
custom_ingress="$(awk '/name: nix-sites-custom-hosts/,0' "$RENDERED_INGRESS")"
grep -Fq 'traefik.ingress.kubernetes.io/router.priority: "1"' <<<"$custom_ingress"
grep -Fq 'nix-cloudflare-only@kubernetescrd' <<<"$custom_ingress"
grep -Fq 'service: { name: nix-sites-serve, port: { number: 8400 } }' <<<"$custom_ingress"
if grep -Eq '^ *- host:|hosts:' <<<"$custom_ingress"; then
  echo 'The custom-hostname Ingress must not name a host.' >&2
  exit 1
fi
assert_before "apply-stdin:nix-sites-worker,nix-sites-worker" "rollout:-n nix rollout status deployment/nix-sites-serve"
# Every first-party image the manifests pull is one CI publishes (ci-images.yml plan lines).
published="$(sed -nE 's/^ *plan ([a-z-]+) deploy\/docker\/.*/\1/p' "$repo_root/.github/workflows/ci-images.yml" | sort -u)"
pulled="$(sed -nE 's/^ *image: registry\.example\.test\/([^:]+):render-order$/\1/p' "$RENDERED_ALL" | sort -u)"
test -n "$published" && test -n "$pulled"
unpublished="$(comm -23 <(printf '%s\n' "$pulled") <(printf '%s\n' "$published"))"
if [ -n "$unpublished" ]; then
  echo "Manifests pull images CI does not publish: $unpublished" >&2
  exit 1
fi
if grep -E '^ *image: registry\.example\.test/' "$RENDERED_ALL" | grep -vqE ':render-order$'; then
  echo 'A first-party image is not tagged with the release TAG.' >&2
  exit 1
fi
# Client address: Caddy trusts the pod network for CF-Connecting-IP; the ingress admits Cloudflare only.
grep -Fq 'name: NIX_TRUSTED_PROXY_CIDR' "$RENDERED_WEB"
grep -Fq 'value: "10.42.0.0/16"' "$RENDERED_WEB"
grep -Fq 'router.middlewares: nix-cloudflare-only@kubernetescrd' "$RENDERED_INGRESS"
test "$(grep -A1 -xF 'apply-file:deploy/k8s/cloudflare-only.yaml' "$KUBECTL_LOG" | tail -n 1)" = 'apply-stdin:nix,nix-sites,nix-sites-custom-hosts'
grep -Fq 'client_ip_headers CF-Connecting-IP' "$repo_root/deploy/k8s/Caddyfile"
# In-cluster object store: buckets and the sites read account exist before anything uses them.
assert_before "apply-file:deploy/k8s/objectstore.yaml" "wait:-n nix wait --for=condition=complete job/nix-storage-init-render-order"
assert_before "wait:-n nix wait --for=condition=complete job/nix-storage-init-render-order" "apply-stdin:nix-api-data-protection,nix-api,nix-api"
grep -Fq 'handle /{$NIX_OBJECT_STORE_BUCKET}/*' "$repo_root/deploy/k8s/Caddyfile"
grep -Fq 'name: NIX_OBJECT_STORE_BUCKET' "$RENDERED_WEB"
# Site builds upload through the app origin, so the sites bucket needs the same route.
grep -Fq 'handle /{$NIX_SITES_BUCKET}/*' "$repo_root/deploy/k8s/Caddyfile"
grep -A1 -F 'name: NIX_SITES_BUCKET' "$RENDERED_WEB" | grep -Fq 'name: nix-sites, key: bucket'
# Zitadel: own database created before it starts, invite-only, served at auth.$DOMAIN.
assert_before "wait:-n nix wait --for=condition=complete job/nix-db-seed" "wait:-n nix wait --for=condition=complete job/nix-zitadel-db-render-order"
grep -Fq 'ZITADEL_EXTERNALDOMAIN: "auth.nix.example.test"' "$RENDERED_ZITADEL"
grep -Fq 'ZITADEL_DEFAULTINSTANCE_LOGINPOLICY_ALLOWREGISTER: "false"' "$RENDERED_ZITADEL"
grep -Fq 'key: masterkey' "$RENDERED_ZITADEL"
if grep -Fq 'ZITADEL_DATABASE_POSTGRES_ADMIN' "$RENDERED_ZITADEL"; then
  echo 'Zitadel received database administrator credentials.' >&2
  exit 1
fi
grep -Fq 'host: "auth.nix.example.test"' "$RENDERED_INGRESS"
grep -Fq 'service: { name: nix-zitadel, port: { number: 8080 } }' "$RENDERED_INGRESS"
grep -Fq 'rollout:-n nix rollout status deployment/nix-zitadel --timeout=900s' "$KUBECTL_LOG"
grep -Fq 'apply-file:deploy/k8s/backup.yaml' "$KUBECTL_LOG"
# Third-party images are pinned to a version.
if grep -E '^ *image: ' "$RENDERED_ALL" | grep -vE ':[A-Za-z0-9._-]+$|registry\.example\.test/' | grep -q .; then
  echo 'An image is not pinned to a tag.' >&2
  exit 1
fi
: > "$KUBECTL_LOG"
if MISSING_SITES_KEY=1 run_deploy 2>/dev/null; then
  echo 'Deployment accepted a sites secret without the read key.' >&2
  exit 1
fi
if grep -Fq 'apply-stdin:' "$KUBECTL_LOG"; then
  echo 'Deployment applied workloads before validating the sites secret.' >&2
  exit 1
fi
run_deploy
# Without OIDC_ISSUER, Core trusts the bundled Zitadel.
OIDC_ISSUER= run_deploy
grep -Fq 'value: "https://auth.nix.example.test"' "$RENDERED_API"

if grep -Eq 'nix-indexer|OpenSearch|opensearch|index-password|index-url' "$RENDERED_WORKERS" "$RENDERED_API" "$RENDERED_RABBITMQ"; then
  echo 'Deployment still renders retired search components.' >&2
  exit 1
fi
assert_before "kubectl:-n nix patch statefulset nix-opensearch" "delete:-n nix delete statefulset/nix-opensearch"
grep -Fq '"whenDeleted":"Retain","whenScaled":"Retain"' "$KUBECTL_LOG"
assert_before "delete:-n nix delete deployment/nix-indexer" "create-configmap:nix-rabbitmq-config"
if grep -Eq 'delete.*(persistentvolume|pvc)' "$KUBECTL_LOG"; then
  echo 'Deployment attempted to delete retained storage.' >&2
  exit 1
fi
assert_before "kubectl:-n nix patch statefulset nix-loki" "delete:-n nix delete statefulset/nix-loki"
grep -Fq 'kubectl:-n nix patch statefulset nix-loki --type=merge -p {"spec":{"persistentVolumeClaimRetentionPolicy":{"whenDeleted":"Retain","whenScaled":"Retain"}}}' "$KUBECTL_LOG"
assert_before "delete:-n nix delete deployment/nix-alloy deployment/nix-grafana" "delete:-n nix delete statefulset/nix-loki"
assert_before "delete:-n nix delete statefulset/nix-loki" "create-configmap:nix-rabbitmq-config"
grep -Fq 'delete:-n nix delete service/nix-loki service/nix-grafana --ignore-not-found' "$KUBECTL_LOG"
grep -Fq 'serviceaccount/nix-alloy role/nix-alloy rolebinding/nix-alloy configmap/nix-loki-config configmap/nix-alloy-config configmap/nix-grafana-provisioning secret/nix-observability --ignore-not-found' "$KUBECTL_LOG"
if grep -Eq '(create-configmap|apply-file|apply-stdin|rollout):.*(loki|alloy|grafana|observability)' "$KUBECTL_LOG"; then
  echo 'Deployment still starts retired observability components.' >&2
  exit 1
fi
assert_before "kubectl:-n nix rollout restart statefulset/nix-rabbitmq" "rollout:-n nix rollout status statefulset/nix-rabbitmq"
: > "$KUBECTL_LOG"
if FAIL_RETIRED_SEARCH_LOOKUP=1 run_deploy; then
  echo 'Deployment ignored a failed retained-storage lookup.' >&2
  exit 1
fi
if grep -Eq 'delete:.*nix-opensearch' "$KUBECTL_LOG"; then
  echo 'Deployment deleted search before ensuring its storage is retained.' >&2
  exit 1
fi
: > "$KUBECTL_LOG"
MISSING_RETIRED_SEARCH=1 run_deploy
if grep -Fq 'patch statefulset nix-opensearch' "$KUBECTL_LOG"; then
  echo 'Deployment patched a missing retired search set.' >&2
  exit 1
fi
: > "$KUBECTL_LOG"
MISSING_RETIRED_LOKI=1 run_deploy
if grep -Fq 'patch statefulset nix-loki' "$KUBECTL_LOG"; then
  echo 'Deployment patched a missing retired Loki set.' >&2
  exit 1
fi
for failed_loki_step in FAIL_RETIRED_LOKI_LOOKUP FAIL_RETIRED_LOKI_PATCH; do
  : > "$KUBECTL_LOG"
  if (export "$failed_loki_step=1"; run_deploy); then
    echo "Deployment ignored $failed_loki_step." >&2
    exit 1
  fi
  if grep -Eq 'delete:.*(nix-loki|nix-grafana|nix-alloy)' "$KUBECTL_LOG"; then
    echo 'Deployment retired observability before ensuring its storage is retained.' >&2
    exit 1
  fi
done
# Production sites and push settings come from the manifest, not hand edits.
OIDC_ISSUER= run_deploy
grep -A1 -F 'name: Nix__Sites__RequireOperatorApproval' "$RENDERED_API" | grep -Fq 'value: "true"'
grep -Fq 'key: api-token, optional: true' "$RENDERED_API"
grep -Fq 'name: Nix__Sites__Cloudflare__ManagedZones__0__WorkspaceId' "$RENDERED_API"
grep -Fq 'name: Nix__Sites__CustomHostnameTarget' "$RENDERED_API"
grep -A1 -F 'name: Nix__Push__VapidPublicKey' "$RENDERED_API" | grep -Fq 'name: nix-push-vapid, key: public-key, optional: true'
grep -Fq 'automountServiceAccountToken: false' "$RENDERED_API"
if grep -Fq 'private-key' "$RENDERED_API"; then
  echo 'Core received the VAPID private key.' >&2
  exit 1
fi
NIX_SITES_REQUIRE_OPERATOR_APPROVAL=false run_deploy
grep -A1 -F 'name: Nix__Sites__RequireOperatorApproval' "$RENDERED_API" | grep -Fq 'value: "false"'
if NIX_SITES_REQUIRE_OPERATOR_APPROVAL=maybe run_deploy 2>/dev/null; then
  echo 'Deployment accepted an invalid operator-approval flag.' >&2
  exit 1
fi
# The template sync job receives every variable its script requires.
test -n "$(sed -nE "s/.*required\\('(NIX_TEMPLATE_BOOT_[A-Z_]+)'\\).*/\\1/p" "$repo_root/deploy/template-sync/sync-managed-templates.mjs")"
for required_variable in $(sed -nE "s/.*required\('(NIX_TEMPLATE_BOOT_[A-Z_]+)'\).*/\1/p" "$repo_root/deploy/template-sync/sync-managed-templates.mjs"); do
  if ! grep -Fq "name: $required_variable" "$RENDERED_TEMPLATE_SYNC"; then
    echo "Template sync job does not set $required_variable." >&2
    exit 1
  fi
done
grep -A1 -F 'name: NIX_TEMPLATE_BOOT_REVISION' "$RENDERED_TEMPLATE_SYNC" | grep -Fq 'value: "render-order"'
grep -Fq 'value: "$(NIX_OBJECT_STORE_ENDPOINT),$(NIX_OBJECT_STORE_PUBLIC_ORIGIN)"' "$RENDERED_TEMPLATE_SYNC"
# A first install skips managed templates and still applies the origin lock and Ingress.
: > "$KUBECTL_LOG"
rm -f "$RENDERED_INGRESS"
run_first_install
if grep -Fq 'nix-template-boot' "$KUBECTL_LOG"; then
  echo 'A first install ran the managed-template step.' >&2
  exit 1
fi
assert_before "rollout:-n nix rollout status deployment/nix-zitadel --timeout=900s" "apply-file:deploy/k8s/cloudflare-only.yaml"
test "$(grep -A1 -xF 'apply-file:deploy/k8s/cloudflare-only.yaml' "$KUBECTL_LOG" | tail -n 1)" = 'apply-stdin:nix,nix-sites,nix-sites-custom-hosts'
grep -Fq 'host: "auth.nix.example.test"' "$RENDERED_INGRESS"
if (PATH="$fake_bin:$PATH" REGISTRY=r TAG=t OIDC_CLIENT_ID=c DOMAIN=nix.example.test \
  NIX_DEPLOY_TARGET=kubernetes bash "$repo_root/deploy/k8s/deploy.sh" >/dev/null 2>&1); then
  echo 'Deployment ran without template configuration while managed templates are enabled.' >&2
  exit 1
fi
# The kubelet cannot verify runAsNonRoot against a named image user (the node images run as "node").
if awk 'BEGIN { RS = "\n---\n" } /runAsNonRoot: true/ && !/runAsUser:/ { found = 1 } END { exit !found }' "$RENDERED_ALL"; then
  echo 'A runAsNonRoot pod has no numeric runAsUser.' >&2
  exit 1
fi
# Collab reads NIX_COLLAB_PORT, which the nix-collab Service's link variables would overwrite.
awk 'BEGIN { RS = "\n---\n" } /name: nix-collab, namespace/ && /kind: Deployment/ && /enableServiceLinks: false/ { found = 1 } END { exit !found }' "$RENDERED_ALL"
# The worker's readiness needs the public origin, so the Ingress precedes its rollout wait.
: > "$KUBECTL_LOG"
run_deploy
assert_before "apply-file:deploy/k8s/cloudflare-only.yaml" "rollout:-n nix rollout status deployment/nix-worker"
assert_before "rollout:-n nix rollout status deployment/nix-worker" "apply-stdin:nix-template-boot,nix-template-boot-render-order"
# auth.$DOMAIN must not fall to the sites wildcard: it sits in its own lowest-priority Ingress.
awk 'BEGIN { RS = "\n---\n" } /name: nix-sites\n/ && /host: "\*\.nix\.example\.test"/ && /router.priority: "1"/ && !/host: "auth\./ { found = 1 } END { exit !found }' "$RENDERED_INGRESS"
awk 'BEGIN { RS = "\n---\n" } /name: nix\n/ && /host: "auth\.nix\.example\.test"/ && !/host: "\*\./ { found = 1 } END { exit !found }' "$RENDERED_INGRESS"
# nixctl exchanges its PAT at Core's public route; without it the SPA fallback answers 405.
grep -Fq 'handle /public/v1/auth/token {' "$repo_root/deploy/k8s/Caddyfile"
echo "deployment render-order self-test passed"
