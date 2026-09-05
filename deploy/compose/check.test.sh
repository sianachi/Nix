#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
bash -n deploy/compose/*.sh deploy/docker/build-and-push.sh deploy/k8s/deploy.sh
node --check deploy/compose/smoke.mjs
# Validate real Compose interpolation, without printing credentials.
docker compose --env-file deploy/compose.prod.env.example -f deploy/compose.prod.yml --profile maintenance config --format json > "$fixture/compose.json"
python3 - "$fixture/compose.json" <<'PY'
import json,sys
c=json.load(open(sys.argv[1])); s=c['services']
assert s['nix-versitygw']['image']=='versity/versitygw:v1.7.0'
assert c['volumes']['nix-versity-data']['name']=='nix-versity-data'
assert c['volumes']['nix-caddy-data']['name']=='nix-caddy-data'
assert s['nix-web']['environment']['NIX_OBJECT_STORE_BUCKET']=='nix-worker-jobs'
assert 'NIX_COLLAB_MIGRATOR_CONNECTION_STRING' not in s['nix-collab']['environment']
assert s['nix-collab-migrate']['environment']['NIX_COLLAB_MIGRATOR_CONNECTION_STRING']
assert not s['nix-versitygw'].get('ports')
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
if command=='auth': print(json.dumps(dict(apiUrl=os.environ.get('TEST_API_URL','https://production.example'))))
elif command=='import':
 print(json.dumps(dict(rootItemId='smoke-root',createdCount=2,atomic=True,omissions=[],loss=[])))
elif command=='export':
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
 print('localhost/nix/api:test')
elif 'run' in args and args[-1]=='nix-migrate' and os.environ.get('FAIL_MIGRATION'):
 sys.exit(1)
PYCODE
chmod +x "$fixture/bin/docker"
export DOCKER_TEST_LOG="$fixture/docker-calls" COMPOSE_TEST_CONFIG="$fixture/compose.json"
export NIX_DEPLOY_ENV="$root/deploy/compose.prod.env.example" NIX_BACKUP_REFERENCE=fixture-backup
bash deploy/compose/deploy.sh > "$fixture/deploy-result"
python3 - "$DOCKER_TEST_LOG" <<'PYCODE'
import sys
calls=open(sys.argv[1]).read().splitlines()
stop=next(i for i,s in enumerate(calls) if ' stop nix-web ' in s)
migrate=next(i for i,s in enumerate(calls) if s.endswith('run --rm --no-deps nix-migrate'))
doc=next(i for i,s in enumerate(calls) if s.endswith('run --rm --no-deps nix-collab-migrate'))
start=next(i for i,s in enumerate(calls) if ' up ' in s and s.endswith('nix-api nix-collab'))
assert stop < migrate < doc < start
assert not any('--remove-orphans' in s or ' down ' in s for s in calls)
PYCODE
: > "$DOCKER_TEST_LOG"
if FAIL_MIGRATION=1 bash deploy/compose/deploy.sh > "$fixture/deploy-failure" 2>&1; then
 echo 'Rollout accepted a failed migration' >&2; exit 1
fi
if rg -q 'up .*nix-api nix-collab' "$DOCKER_TEST_LOG"; then
 echo 'Rollout restarted writers after a failed migration' >&2; exit 1
fi
echo 'Compose configuration, smoke success/failure cleanup, and default target checks passed.'
