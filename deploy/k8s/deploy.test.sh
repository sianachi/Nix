#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

fake_bin="$test_root/bin"
mkdir -p "$fake_bin"
export KUBECTL_LOG="$test_root/kubectl.log"
export RENDERED_PRESET_JOB="$test_root/template-presets.yaml"

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

if [[ " $* " == *" apply -f - "* ]]; then
  payload="$(</dev/stdin)"
  names="$(printf '%s\n' "$payload" | sed -nE \
    -e 's/^metadata: \{ name: ([^,}]+).*$/\1/p' \
    -e 's/^  name: ([^ ]+)$/\1/p' | paste -sd, -)"
  printf 'apply-stdin:%s\n' "$names" >> "$KUBECTL_LOG"
  if [[ "$payload" == *"nix-template-presets-"* ]]; then
    printf '%s\n' "$payload" > "$RENDERED_PRESET_JOB"
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
bash "$repo_root/deploy/k8s/deploy.sh" >/dev/null

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

echo "deployment render-order self-test passed"
