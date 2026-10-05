#!/usr/bin/env bash
# Exercises offsite.sh against a stubbed docker: credential file checks, the --check gate on push,
# hardened restic invocations and retention flags. Nothing here reaches Docker or R2.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
offsite=$here/offsite.sh
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
chmod 700 "$work"
mkdir "$work/bin"
cat > "$work/bin/docker" <<'STUB'
#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ['OFFSITE_DOCKER_LOG'], 'a') as log:
    log.write(' '.join(args) + '\n')
restic = args[args.index('--cache-dir') + 2:] if '--cache-dir' in args else []
if not restic and args[args.index('--entrypoint') + 1:args.index('--entrypoint') + 2] == ['/bin/chown'] if '--entrypoint' in args else False:
    sys.exit(0)
if not restic:
    sys.exit('unexpected docker call')
if restic[:2] == ['cat', 'config']:
    sys.exit(0 if os.environ.get('STUB_REPO_EXISTS') else 10)
if restic[0] == 'backup':
    if os.environ.get('STUB_FAIL_BACKUP'):
        sys.exit(1)
    print(json.dumps({'message_type': 'status', 'percent_done': 0.5}))
    print(json.dumps({'message_type': 'summary', 'snapshot_id': '0123456789abcdef' * 4}))
STUB
chmod +x "$work/bin/docker"
export PATH="$work/bin:$PATH" OFFSITE_DOCKER_LOG="$work/docker.log"

secret=never-print-this-secret-value
env_file=$work/backup.env
write_env() {
  {
    echo '# restic repository credentials'
    echo 'RESTIC_REPOSITORY=s3:https://account.r2.cloudflarestorage.com/nix-backup/restic/nix-production'
    echo "RESTIC_PASSWORD=$secret-password"
    echo "AWS_ACCESS_KEY_ID=$secret-key-id"
    echo "AWS_SECRET_ACCESS_KEY=$secret-access-key"
    echo 'AWS_DEFAULT_REGION=auto'
    for extra in "$@"; do echo "$extra"; done
  } > "$env_file"
  chmod 600 "$env_file"
}
export NIX_BACKUP_OFFSITE_ENV=$env_file
fail() { echo "offsite.test: $*" >&2; exit 1; }
run() { bash "$offsite" "$@" > "$work/out" 2>&1; }
no_secret() {
  if grep -q "$secret" "$work/out" "$work/docker.log"; then fail "credential value printed or passed as an argument: $1"; fi
}
refuses() { # label expected-message args...
  local label=$1 expected=$2; shift 2
  : > "$work/docker.log"
  if run "$@"; then fail "accepted: $label"; fi
  grep -q -- "$expected" "$work/out" || { cat "$work/out" >&2; fail "unclear refusal for $label"; }
  [[ ! -s $work/docker.log ]] || fail "docker ran before refusing: $label"
  no_secret "$label"
}

bash "$here/backup.test.sh" --fixture "$work/pre-1234567"
bash "$here/backup.test.sh" --fixture "$work/unchecked"
printf 'tampered\n' >> "$work/unchecked/nix.dump"
write_env

# Push requires a directory that passes backup.sh --check, before any credential or Docker use.
refuses 'unchecked backup' 'backup.sh --check failed' push "$work/unchecked" --tag kind=release
refuses 'relative backup path' 'absolute path' push pre-1234567
refuses 'malformed tag' 'tag must be key=value' push "$work/pre-1234567" --tag 'kind=a,b'

# The credentials file must be private, owned, and hold exactly restic's variables.
chmod 640 "$env_file"
refuses 'group-readable credentials' 'readable by group or others' push "$work/pre-1234567"
chmod 604 "$env_file"
refuses 'world-readable credentials' 'readable by group or others' snapshots
write_env 'EXTRA_TOKEN=abc'
refuses 'unexpected key' 'unexpected key EXTRA_TOKEN' snapshots
write_env "export RESTIC_CACHE_DIR=$secret"
refuses 'malformed line' 'line 7 is not KEY=value' snapshots
write_env "RESTIC_PASSWORD=$secret-again"
refuses 'duplicate key' 'sets RESTIC_PASSWORD more than once' snapshots
write_env
grep -v '^AWS_DEFAULT_REGION=' "$env_file" > "$work/env" && cat "$work/env" > "$env_file"
refuses 'missing key' 'does not set AWS_DEFAULT_REGION' snapshots
write_env
NIX_BACKUP_OFFSITE_ENV=backup.env refuses 'relative credentials path' 'must be an absolute path' snapshots
NIX_BACKUP_OFFSITE_ENV=$work/absent.env refuses 'absent credentials' 'credentials file not found' snapshots

# A successful push: hardened container, env file by reference only, read-only mount, then check.
: > "$work/docker.log"
run push "$work/pre-1234567" --tag kind=release --tag sha=1234567 || { cat "$work/out" >&2; fail 'push failed'; }
no_secret push
grep -qx "offsite: snapshot $(printf '0123456789abcdef%.0s' 1 2 3 4)" "$work/out" || fail 'snapshot id not printed'
[[ $(wc -l < "$work/docker.log") -eq 2 ]] || fail 'push should run backup then check'
backup_call=$(sed -n 1p "$work/docker.log")
for flag in 'run --rm --read-only --cap-drop=ALL --cap-add=DAC_READ_SEARCH' \
  '--security-opt=no-new-privileges:true' '--network bridge' '--memory=1g' \
  '--tmpfs /cache:rw,noexec,nosuid,size=256m,mode=0700' "--env-file $env_file " \
  "--mount type=bind,src=$work/pre-1234567,dst=/backup/pre-1234567,readonly " \
  'restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510 --cache-dir /cache backup --json' \
  '--host nix-production --tag kind=release --tag sha=1234567 /backup/pre-1234567'; do
  [[ $backup_call == *"$flag"* ]] || fail "backup call lacks: $flag"
done
if [[ $backup_call == *--cap-add=CHOWN* ]]; then fail 'backup call has restore capabilities'; fi
sed -n 2p "$work/docker.log" | grep -q -- '--cache-dir /cache check$' || fail 'check did not follow backup'

: > "$work/docker.log"
if STUB_FAIL_BACKUP=1 run push "$work/pre-1234567"; then fail 'accepted a failed restic backup'; fi
[[ $(wc -l < "$work/docker.log") -eq 1 ]] || fail 'checked the repository after a failed backup'

# init refuses an existing repository and creates a missing one.
: > "$work/docker.log"
if STUB_REPO_EXISTS=1 run init; then fail 'init accepted an existing repository'; fi
grep -q 'already exists' "$work/out" || fail 'init refusal unclear'
if grep -q -- '--cache-dir /cache init' "$work/docker.log"; then fail 'init ran against an existing repository'; fi
: > "$work/docker.log"
run init || { cat "$work/out" >&2; fail 'init failed'; }
grep -q -- '--cache-dir /cache init$' "$work/docker.log" || fail 'init not run'

# Retention: each kind is its own group, and forget prunes.
: > "$work/docker.log"
run forget
grep -q -- 'forget --host nix-production --tag kind=release --group-by host --keep-last 10 --prune$' "$work/docker.log" \
  || fail 'release retention wrong'
grep -q -- 'forget --host nix-production --tag kind=nightly --group-by host --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune$' "$work/docker.log" \
  || fail 'nightly retention wrong'

: > "$work/docker.log"
run check --read-data-subset=5%
grep -q -- '--cache-dir /cache check --read-data-subset=5%$' "$work/docker.log" || fail 'subset check not passed through'
refuses 'bad subset' 'usage:' check --read-data-subset=500%

# Restore only into an empty directory, with the ownership capabilities restore needs.
mkdir -m 700 "$work/busy" && touch "$work/busy/file"
refuses 'non-empty restore target' 'not empty' restore latest "$work/busy"
refuses 'bad snapshot id' 'not a snapshot id' restore 'latest;rm' "$work/restore"
: > "$work/docker.log"
run restore 0123abcd "$work/restore" || { cat "$work/out" >&2; fail 'restore failed'; }
grep -q -- "--cap-add=CHOWN --cap-add=FOWNER --cap-add=DAC_OVERRIDE --mount type=bind,src=$work/restore,dst=/restore " "$work/docker.log" \
  || fail 'restore call wrong'
grep -q -- 'restore 0123abcd --host nix-production --target /restore --verify$' "$work/docker.log" || fail 'restore arguments wrong'
# The restored tree is handed to the invoking user, from an offline, chown-only container.
grep -q -- "--network none --cap-drop=ALL --cap-add=CHOWN --cap-add=DAC_READ_SEARCH --security-opt=no-new-privileges:true --entrypoint /bin/chown --mount type=bind,src=$work/restore,dst=/restore .* -R $(id -u):$(id -g) /restore$" "$work/docker.log" \
  || fail 'restore did not hand the tree to the invoking user'
no_secret restore
echo 'offsite.sh checks passed.'
