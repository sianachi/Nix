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

if [[ " $* " == *" get secret nix-rabbitmq "* && " $* " == *"metadata.resourceVersion"* ]]; then
  printf '12345'
  exit 0
fi

if [[ " $* " == *" get secret nix-object-store "* && " $* " == *"metadata.resourceVersion"* ]]; then
  printf '67890'
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
  if [[ "$payload" == *"name: nix-import-worker"* && "$payload" == *"name: nix-export-worker"* && "$payload" == *"name: nix-plugin-worker"* ]]; then
    printf '%s\n' "$payload" > "$RENDERED_WORKERS"
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

PATH="$fake_bin:$PATH" \
REGISTRY=registry.example.test \
TAG=render-order \
OIDC_ISSUER=https://identity.example.test \
OIDC_CLIENT_ID=web-client \
DOMAIN=nix.example.test \
TEMPLATE_BOOT_WORKSPACE_ID=11111111-1111-4111-8111-111111111111 \
TEMPLATE_BOOT_OIDC_AUDIENCE=project-id \
TEMPLATE_BOOT_PVC=template-files \
TEMPLATE_BOOT_SERVICE_KEY_SECRET=template-service-key \
NIX_DEPLOY_TARGET=kubernetes bash "$repo_root/deploy/k8s/deploy.sh" >/dev/null

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
grep -Fq 'create-configmap:nix-loki-config' "$KUBECTL_LOG"
grep -Fq 'create-configmap:nix-alloy-config' "$KUBECTL_LOG"
grep -Fq 'create-configmap:nix-grafana-provisioning' "$KUBECTL_LOG"
grep -Fq 'apply-file:deploy/k8s/observability.yaml' "$KUBECTL_LOG"
grep -Fq 'kubectl:-n nix rollout restart statefulset/nix-loki deployment/nix-alloy deployment/nix-grafana' "$KUBECTL_LOG"
grep -Fq 'apply-stdin:nix-rabbitmq,nix-rabbitmq,rabbitmq-ingress' "$KUBECTL_LOG"
grep -Fq 'nix.io/rabbitmq-secret-version: "12345"' "$RENDERED_RABBITMQ"
grep -Fq 'key: api-password' "$RENDERED_RABBITMQ"
grep -Fq 'key: import-password' "$RENDERED_RABBITMQ"
grep -Fq 'key: export-password' "$RENDERED_RABBITMQ"
grep -Fq 'key: index-password' "$RENDERED_RABBITMQ"
grep -Fq 'key: plugin-password' "$RENDERED_RABBITMQ"
grep -Fq 'nix.io/rabbitmq-secret-version: "12345"' "$RENDERED_API"
test "$(grep -Fc 'nix.io/object-store-secret-version: "67890"' "$RENDERED_API")" -eq 1
grep -Fq 'key: api-url' "$RENDERED_API"
grep -Fq 'name: Nix__ObjectStorage__PublicOrigin' "$RENDERED_API"
grep -Fq 'key: public-origin' "$RENDERED_API"
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
test "$(grep -Fc 'nix.io/object-store-secret-version: "67890"' "$RENDERED_WORKERS")" -eq 3
grep -Fq 'key: import-url' "$RENDERED_WORKERS"
grep -Fq 'key: export-url' "$RENDERED_WORKERS"
grep -Fq 'key: index-url' "$RENDERED_WORKERS"
grep -Fq 'key: plugin-url' "$RENDERED_WORKERS"
grep -Fq 'name: NIX_OBJECT_STORE_PUBLIC_ORIGIN' "$RENDERED_WEB"
grep -Fq 'key: public-origin' "$RENDERED_WEB"
test "$(grep -Fc 'nix.io/object-store-secret-version: "67890"' "$RENDERED_WEB")" -eq 1

echo "deployment render-order self-test passed"
