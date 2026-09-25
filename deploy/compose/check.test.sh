#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
bash -n deploy/compose/*.sh deploy/docker/build-and-push.sh deploy/k8s/deploy.sh
node --check deploy/compose/smoke.mjs
bash deploy/compose/release.test.sh
# Validate real Compose interpolation, without printing credentials.
docker compose --env-file deploy/compose.prod.env.example -f deploy/compose.prod.yml --profile maintenance config --format json > "$fixture/compose.json"
python3 - "$fixture/compose.json" <<'PY'
import json,sys
c=json.load(open(sys.argv[1])); s=c['services']
assert s['nix-versitygw']['image']=='versity/versitygw:v1.7.0'
assert s['nix-api']['image']=='ghcr.io/sianachi/nix/api:replace-with-commit-sha'
assert s['nix-import-worker']['image']=='ghcr.io/sianachi/nix/worker:replace-with-commit-sha'
assert c['volumes']['nix-versity-data']['name']=='nix-versity-data'
assert c['volumes']['nix-caddy-data']['name']=='nix-caddy-data'
assert s['nix-web']['environment']['NIX_OBJECT_STORE_BUCKET']=='nix-worker-jobs'
assert 'NIX_COLLAB_MIGRATOR_CONNECTION_STRING' not in s['nix-collab']['environment']
assert s['nix-collab-migrate']['environment']['NIX_COLLAB_MIGRATOR_CONNECTION_STRING']
assert s['nix-api']['environment']['Nix__Pets__WorkerUrl'] == 'http://nix-import-worker:8301'
# The api image is chiseled: it holds only /usr/bin/dotnet (no shell, wget, curl or /dev/tcp).
api_check = s['nix-api'].get('healthcheck', {}).get('test', [])
assert not api_check or (api_check[0] == 'CMD' and api_check[1] not in ('wget', 'curl', 'sh', 'bash')), api_check
assert s['nix-import-worker']['environment']['NIX_COMPANION_DATA_DIR'] == '/var/lib/nix-worker/companion'
assert any(v.get('source') == 'nix-companion-data' for v in s['nix-import-worker']['volumes'])
assert not s['nix-import-worker'].get('ports')
assert not any('companion' in name or 'codex' in name for name in s)
assert not s['nix-versitygw'].get('ports')
assert set(s['docker-socket-proxy']['networks']) == {'docker-logs'}
assert set(s['alloy']['networks']) == {'docker-logs', 'observability'}
assert set(s['loki']['networks']) == {'observability'}
assert set(s['grafana']['networks']) == {'observability', 'grafana-access'}
assert c['networks']['docker-logs']['internal']
assert c['networks']['observability']['internal']
assert s['docker-socket-proxy']['environment']['POST'] == '0'
assert not s['docker-socket-proxy'].get('ports')
assert not s['loki'].get('ports')
assert s['grafana']['ports'][0]['host_ip'] == '127.0.0.1'
assert s['grafana']['environment']['GF_AUTH_ANONYMOUS_ENABLED'] == 'false'
from pathlib import Path
edge=Path('deploy/Caddyfile.prod').read_text()
exchange=edge.split('handle /public/v1/auth/token {',1)[1].split('\n\thandle ',1)[0]
assert 'reverse_proxy nix-api:8080' in exchange
assert 'header_up X-Forwarded-For {http.request.header.CF-Connecting-IP}' in exchange
PY
mkdir "$fixture/bin"
cat > "$fixture/bin/pdftotext" <<'PY'
#!/usr/bin/env python3
print('Nix release smoke test')
PY
cat > "$fixture/bin/nixctl" <<'PY'
#!/usr/bin/env python3
import sys,json,os,zipfile
args=sys.argv[4:]
with open(os.environ['TEST_LOG'],'a') as f: f.write(' '.join(args)+'\n')
command=args[0]
if command=='auth' and os.environ.get('FAIL_AUTH'):
 sys.stderr.write(os.environ['FAIL_AUTH']+'\n'); sys.exit(4)
elif command=='auth': print(json.dumps(dict(apiUrl=os.environ.get('TEST_API_URL','https://production.example'))))
elif command=='import':
 print(json.dumps(dict(rootItemId='smoke-root',createdCount=2,atomic=True,omissions=[],loss=[])))
elif command=='item' and '--parent' in args:
 print(json.dumps(dict(items=[dict(id='original-file',type='file')])))
elif command=='file':
 path=args[args.index('--out')+1]
 open(path,'w').write('Nix release smoke test\n\nStorage transfer and document conversion verification.\n')
 print('{}')
elif command=='export':
 assert args[args.index('--scope')+1]=='item'
 fmt=args[args.index('--format')+1]
 if os.environ.get('FAIL_EXPORT')==fmt: sys.exit(1)
 path=args[args.index('--out')+1]
 if fmt=='pdf': open(path,'wb').write(b'%PDF-1.4')
 else:
  with zipfile.ZipFile(path,'w') as z:
   z.writestr('word/document.xml' if fmt=='docx' else 'manifest.json','<doc>Nix release smoke test</doc>' if fmt=='docx' else '{}')
 print(json.dumps(dict(omissions=[],omitted=0)))
else: print('{}')
PY
chmod +x "$fixture/bin/"*
export PATH="$fixture/bin:$PATH" NIXCTL_BIN="$fixture/bin/nixctl" NIXCTL_PROFILE=test NIX_SMOKE_WORKSPACE=test NIX_SMOKE_ORIGIN=https://production.example TEST_LOG="$fixture/calls"
node deploy/compose/smoke.mjs > "$fixture/result"
rg -q 'item rm smoke-root --workspace test' "$TEST_LOG"
rg -q 'Public import and export smoke checks passed' "$fixture/result"
: > "$TEST_LOG"
if TEST_API_URL=https://staging.example node deploy/compose/smoke.mjs > "$fixture/mismatch" 2>&1; then
  echo 'Smoke runner accepted the wrong instance' >&2; exit 1
fi
if rg -q '^import ' "$TEST_LOG"; then echo 'Origin mismatch mutated data' >&2; exit 1; fi
: > "$TEST_LOG"
# A refused release credential fails preflight by reason, names the profile and never echoes CLI diagnostics.
for kind in revoked expired; do
  case "$kind" in
    revoked) refusal="Personal access token 'tok-private-id' was revoked at 2026-09-01T10:00:00.0000000+00:00." ;;
    expired) refusal="Personal access token 'tok-private-id' expired at 2026-09-01T10:00:00.0000000+00:00." ;;
  esac
  if FAIL_AUTH="$refusal" node deploy/compose/smoke.mjs --preflight > "$fixture/credential" 2>&1; then
    echo "Preflight accepted a $kind token" >&2; exit 1
  fi
  rg -q "nixctl profile 'test' has an? $kind access token \\($kind 2026-09-01T10:00:00" "$fixture/credential"
  rg -q 'Rotate the release-check token' "$fixture/credential"
  if rg -q 'tok-private-id' "$fixture/credential"; then echo 'Preflight echoed CLI diagnostics' >&2; exit 1; fi
done
if FAIL_AUTH='connect ECONNREFUSED' node deploy/compose/smoke.mjs --preflight > "$fixture/credential" 2>&1; then
  echo 'Preflight accepted an unreachable origin' >&2; exit 1
fi
rg -q "nixctl profile 'test' could not authenticate" "$fixture/credential"
if rg -q '^(item|import) ' "$TEST_LOG"; then echo 'Credential failure ran further commands' >&2; exit 1; fi
: > "$TEST_LOG"
if FAIL_EXPORT=pdf node deploy/compose/smoke.mjs > "$fixture/failure" 2>&1; then
  echo 'Smoke runner accepted a failed PDF export' >&2; exit 1
fi
rg -q 'item rm smoke-root --workspace test' "$TEST_LOG"
if bash deploy/k8s/deploy.sh > "$fixture/k8s" 2>&1; then
  echo 'Kubernetes ran without explicit target selection' >&2; exit 1
fi
rg -q 'Kubernetes deployment is inactive' "$fixture/k8s"
if bash deploy/docker/build-and-push.sh > "$fixture/registry" 2>&1; then
  echo 'Registry build ran without explicit target selection' >&2; exit 1
fi
rg -q 'Default deployment is Docker Compose' "$fixture/registry"
# Exercise rollout ordering and failure containment without touching Docker services.
cat > "$fixture/bin/docker" <<'PYCODE'
#!/usr/bin/env python3
import sys,os,json
args=sys.argv[1:]
with open(os.environ['DOCKER_TEST_LOG'],'a') as f: f.write(' '.join(args)+'\n')
if 'config' in args and '--format' in args:
 c=json.load(open(os.environ['COMPOSE_TEST_CONFIG']))
 c['services']['nix-api']['environment']['Nix__Bff__PublicOrigin']='https://production.example'
 print(json.dumps(c))
elif 'config' in args and '--images' in args:
 print('localhost/nix/api:test\nghcr.io/sianachi/nix/worker:test')
elif 'run' in args and args[-1]=='nix-migrate' and os.environ.get('FAIL_MIGRATION'):
 sys.exit(1)
PYCODE
chmod +x "$fixture/bin/docker"
export DOCKER_TEST_LOG="$fixture/docker-calls" COMPOSE_TEST_CONFIG="$fixture/compose.json"
bash deploy/compose/backup.test.sh
bash deploy/compose/backup.test.sh --fixture "$fixture/backup"
export NIX_DEPLOY_ENV="$root/deploy/compose.prod.env.example" NIX_BACKUP_REFERENCE="$fixture/backup"
echo '{}' > "$fixture/nixctl-config.json"
export NIXCTL_CONFIG="$fixture/nixctl-config.json"
# An unverified or free-text backup reference stops the rollout before Docker is touched.
for reference in fixture-backup "$fixture/missing-backup"; do
 if NIX_BACKUP_REFERENCE="$reference" bash deploy/compose/deploy.sh > "$fixture/deploy-no-backup" 2>&1; then
  echo "Rollout accepted backup reference $reference" >&2; exit 1
 fi
done
if [ -s "$DOCKER_TEST_LOG" ]; then echo 'Rollout touched Docker without a verified backup' >&2; exit 1; fi
# The host has no Node: deploy.sh reaches nixctl and smoke only through the release-tools image.
if rg -q '\bnode\b' deploy/compose/deploy.sh; then echo 'deploy.sh still calls node' >&2; exit 1; fi
mkdir "$fixture/nodeless"
printf '#!/bin/sh\necho "node called on the host" >&2\nexit 97\n' > "$fixture/nodeless/node"
chmod +x "$fixture/nodeless/node"
PATH="$fixture/nodeless:$PATH" bash deploy/compose/deploy.sh > "$fixture/deploy-result"
python3 - "$DOCKER_TEST_LOG" <<'PYCODE'
import sys
calls=open(sys.argv[1]).read().splitlines()
stop=next(i for i,s in enumerate(calls) if ' stop nix-web ' in s)
migrate=next(i for i,s in enumerate(calls) if s.endswith('run --rm --no-deps nix-migrate'))
doc=next(i for i,s in enumerate(calls) if s.endswith('run --rm --no-deps nix-collab-migrate'))
start=next(i for i,s in enumerate(calls) if ' up ' in s and s.endswith('nix-api nix-collab'))
pull=next(i for i,s in enumerate(calls) if s=='pull --quiet ghcr.io/sianachi/nix/worker:test')
assert not any(s.startswith('pull ') and 'localhost/' in s for s in calls)
assert pull < stop < migrate < doc < start
assert not any('--remove-orphans' in s or ' down ' in s for s in calls)
tools='ghcr.io/sianachi/nix/release-tools:replace-with-commit-sha'
smokes=[i for i,s in enumerate(calls) if s.startswith('run --rm ') and tools+' smoke' in s]
assert len(smokes)==2 and calls[smokes[0]].endswith(' smoke --preflight') and calls[smokes[1]].endswith(tools+' smoke')
assert calls.index('pull --quiet '+tools) < smokes[0] < stop < start < smokes[1]
# Writers stop before the infrastructure `up`, so a RabbitMQ recreate never meets a publisher.
infra=next(i for i,s in enumerate(calls) if ' up ' in s and s.endswith('postgres rabbitmq nix-opensearch nix-versitygw'))
assert stop < infra < migrate
assert all(':/config/nixctl/config.json:ro' in calls[i] for i in smokes)
PYCODE
# The drift preview must run before the first `up` can recreate a service.
python3 - "$DOCKER_TEST_LOG" <<'PYCODE'
import sys
calls=open(sys.argv[1]).read().splitlines()
drift=next(i for i,s in enumerate(calls) if s.endswith("config --hash *"))
assert drift < next(i for i,s in enumerate(calls) if ' up ' in s)
PYCODE
: > "$DOCKER_TEST_LOG"
if FAIL_MIGRATION=1 PATH="$fixture/nodeless:$PATH" bash deploy/compose/deploy.sh > "$fixture/deploy-failure" 2>&1; then
 echo 'Rollout accepted a failed migration' >&2; exit 1
fi
if rg -q 'up .*nix-api nix-collab' "$DOCKER_TEST_LOG"; then
 echo 'Rollout restarted writers after a failed migration' >&2; exit 1
fi
bash deploy/compose/drift.test.sh
bash deploy/compose/prune.test.sh
echo 'Compose configuration, smoke success/failure cleanup, and default target checks passed.'
