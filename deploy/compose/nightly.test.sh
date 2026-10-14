#!/usr/bin/env bash
# Exercises nightly.sh with stub backup.sh and offsite.sh: step order, failure handling and local
# retention of nightly-* directories only, and the backup_runs rows it records through a stub docker.
# Nothing here touches Docker or R2.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
tools=$work/tools
mkdir -p "$tools" "$work/bin" "$work/backups"
cp "$here/nightly.sh" "$tools/nightly.sh"
cat > "$tools/backup.sh" <<'SH'
#!/usr/bin/env bash
echo "backup $*" >> "$TEST_LOG"
[[ $* == --nightly && -z ${FAIL_BACKUP:-} ]] || exit 1
mkdir -m 700 "$NIX_BACKUP_ROOT/nightly-$(date -u +%Y%m%dT%H%M%SZ)"
SH
cat > "$tools/offsite.sh" <<'SH'
#!/usr/bin/env bash
echo "offsite $*" >> "$TEST_LOG"
if [[ $1 == push ]]; then
  if [[ -n ${FAIL_PUSH:-} ]]; then
    # What a failing restic run can print; none of it may reach a recorded value.
    echo 's3:https://SECRET-ACCOUNT.r2.example/bucket AWSAccessKeyId SECRET' >&2
    echo 'AWSAccessKeyId SECRET'
    exit 1
  fi
  echo "offsite: pushing $2"
  echo "offsite: snapshot ${SNAPSHOT:-0123abcd4567}"
fi
SH
real_du=$(command -v du) # resolved before the stub dir leads PATH
printf '#!/usr/bin/env bash\n[[ -z ${FAIL_DU:-} ]] || exit 1\nexec %s "$@"\n' "$real_du" > "$work/bin/du"
if ! command -v flock >/dev/null; then printf '#!/usr/bin/env bash\nexit 0\n' > "$work/bin/flock"; fi
cat > "$work/bin/docker" <<'SH'
#!/usr/bin/env bash
if [[ -n ${DOCKER_DENIED:-} ]]; then
  echo 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock' >&2; exit 1
fi
case $1 in
  info) ;;
  ps) [[ -n ${NO_POSTGRES:-} ]] || echo postgres-container ;;
  exec) # log the psql arguments and the SQL it was given on stdin
    shift; { echo "ARGS $*"; cat; } >> "$DOCKER_LOG"
    [[ -z ${FAIL_RECORD:-} ]] ;;
  *) echo "unexpected docker call: $*" >&2; exit 9 ;;
esac
SH
chmod +x "$work/bin/"* "$tools/"*.sh 2>/dev/null || true
conf=$work/release.conf
cat > "$conf" <<CONF
NIX_DEPLOY_ENV=$work/production.env
NIX_BACKUP_ROOT=$work/backups
NIX_RELEASE_LOCK=$work/release.lock
NIX_NIGHTLY_MARKER=$work/last-nightly-success
CONF
export PATH="$work/bin:$PATH" NIX_RELEASE_CONF="$conf" TEST_LOG="$work/calls" DOCKER_LOG="$work/psql"
fail() { echo "nightly.test: $*" >&2; exit 1; }
stamp() { python3 -c 'import datetime, sys
t = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=float(sys.argv[1]))
print(t.strftime("%Y%m%dT%H%M%SZ"))' "$1"; }
rows() { grep -c '^ARGS' "$DOCKER_LOG" || true; }

b=$work/backups
old=$b/nightly-$(stamp 8) recent=$b/nightly-$(stamp 6) ancient=$b/nightly-$(stamp 400)
mkdir "$old" "$recent" "$ancient" "$b/pre-1234567" "$b/nightly-manual" "$work/elsewhere"
touch -t 202001010000 "$b/pre-1234567"
ln -s "$work/elsewhere" "$b/nightly-$(stamp 30)"
link=$b/nightly-$(stamp 30)

# No Docker access: a plain explanation, no backup attempted, no marker.
: > "$TEST_LOG"; : > "$DOCKER_LOG"
if DOCKER_DENIED=1 bash "$tools/nightly.sh" > "$work/out" 2>&1; then fail 'ran without Docker access'; fi
if id -Gn | tr ' ' '\n' | grep -qx docker; then
  grep -q 'cannot reach Docker: permission denied' "$work/out" || fail 'docker error not reported'
else
  grep -q 'not in the docker group' "$work/out" || fail 'missing docker group not explained'
  grep -q 'systemctl restart user@' "$work/out" || fail 'no remedy given'
fi
[[ ! -s $TEST_LOG ]] || fail 'backup attempted without Docker access'

# A failed push stops retention and keeps every local copy.
: > "$TEST_LOG"; : > "$DOCKER_LOG"
if FAIL_PUSH=1 bash "$tools/nightly.sh" > "$work/out" 2>&1; then fail 'accepted a failed push'; fi
grep -q 'nightly: FAILED during off-host push' "$work/out" || fail 'failure not logged by step'
if grep -q '^offsite forget' "$TEST_LOG"; then fail 'forget ran after a failed push'; fi
[[ ! -e $work/last-nightly-success ]] || fail 'success marker written after a failed push'
[[ -d $old && -d $ancient ]] || fail 'local copies deleted after a failed push'
# The local copy is recorded as succeeded, the push as failed with a fixed phrase and the exit code.
[[ $(rows) -eq 2 ]] || fail 'expected two recorded rows after a failed push'
grep -q 'b_step=local -v b_status=succeeded' "$DOCKER_LOG" || fail 'local success not recorded'
grep -q 'b_step=offsite -v b_status=failed' "$DOCKER_LOG" || fail 'push failure not recorded'
grep -q 'b_error=off-host push failed (exit 1)' "$DOCKER_LOG" || fail 'failure phrase not recorded'
if grep -q SECRET "$DOCKER_LOG"; then fail 'tool output reached a recorded value'; fi
grep -q "SET ROLE nix_backup; SELECT nix_record_backup_run(:'b_started'" "$DOCKER_LOG" || fail 'values are not quoted by psql'
grep -q 'AWSAccessKeyId SECRET' "$work/out" || fail 'push output was not echoed to the journal'

# A failed backup pushes nothing and records a single failed local row.
: > "$TEST_LOG"; : > "$DOCKER_LOG"
if FAIL_BACKUP=1 bash "$tools/nightly.sh" > "$work/out" 2>&1; then fail 'accepted a failed backup'; fi
grep -q 'FAILED during local backup' "$work/out" || fail 'backup failure not logged'
if grep -q '^offsite' "$TEST_LOG"; then fail 'pushed after a failed backup'; fi
[[ $(rows) -eq 1 ]] || fail 'expected one recorded row after a failed backup'
grep -q 'b_step=local -v b_status=failed' "$DOCKER_LOG" || fail 'local failure not recorded'
grep -q 'b_error=local backup failed (exit 1)' "$DOCKER_LOG" || fail 'local failure phrase not recorded'

# A snapshot id that is not hex is dropped, so nothing from the push output reaches SQL.
sleep 1
: > "$TEST_LOG"; : > "$DOCKER_LOG"
SNAPSHOT="abc'; DROP TABLE backup_runs; --" bash "$tools/nightly.sh" > "$work/out" 2>&1 || fail 'nightly run with an odd snapshot id failed'
if grep -q 'DROP TABLE' "$DOCKER_LOG"; then fail 'push output reached a recorded value'; fi
grep -q 'b_step=offsite -v b_status=succeeded -v b_snapshot= ' "$DOCKER_LOG" || fail 'odd snapshot id was not dropped'

# A recorder that cannot reach Postgres, or fails, never changes the result of the backup.
sleep 1
: > "$TEST_LOG"; : > "$DOCKER_LOG"
NO_POSTGRES=1 bash "$tools/nightly.sh" > "$work/out" 2>&1 || fail 'a missing postgres container failed the backup'
grep -q 'backup status not recorded: no single postgres container' "$work/out" || fail 'missing postgres container not logged'
sleep 1
FAIL_RECORD=1 bash "$tools/nightly.sh" > "$work/out" 2>&1 || fail 'a failing recorder failed the backup'
grep -q 'backup status not recorded: offsite succeeded' "$work/out" || fail 'recorder failure not logged'
sleep 1
if FAIL_PUSH=1 FAIL_RECORD=1 bash "$tools/nightly.sh" > "$work/out" 2>&1; then fail 'accepted a failed push'; fi
grep -q 'FAILED during off-host push (exit 1)' "$work/out" || fail 'a failing recorder hid the original exit status'

# Sizing the backup is best effort: a du failure records zero bytes and the backup still succeeds.
sleep 1
: > "$TEST_LOG"; : > "$DOCKER_LOG"
FAIL_DU=1 bash "$tools/nightly.sh" > "$work/out" 2>&1 || fail 'a failing du failed the backup'
grep -q 'b_step=local -v b_status=succeeded -v b_snapshot= -v b_bytes=0 ' "$DOCKER_LOG" || fail 'unsizable backup not recorded with zero bytes'

# Success: backup, push of the new directory, forget, then local retention.
sleep 1 # a distinct stamp from the directories the failed runs left behind
: > "$TEST_LOG"; : > "$DOCKER_LOG"
mkdir -p "$old" "$ancient" # the earlier successful runs already pruned these
bash "$tools/nightly.sh" > "$work/out" 2>&1 || { cat "$work/out" >&2; fail 'nightly run failed'; }
new=$(sed -n 's/^offsite push \(.*\) --tag kind=nightly$/\1/p' "$TEST_LOG")
[[ $new == "$b"/nightly-* && -d $new ]] || fail "pushed an unexpected directory: $new"
[[ $(cut -d' ' -f1,2 "$TEST_LOG" | tr '\n' ' ') == 'backup --nightly offsite push offsite forget ' ]] \
  || fail "unexpected order: $(tr '\n' ' ' < "$TEST_LOG")"
[[ ! -e $old && ! -e $ancient ]] || fail 'nightly directories older than 7 days survived'
for kept in "$recent" "$new" "$b/pre-1234567" "$b/nightly-manual" "$link" "$work/elsewhere"; do
  [[ -e $kept || -L $kept ]] || fail "$kept was deleted"
done
grep -q "deleted local $old" "$work/out" || fail 'deletion not logged'
grep -q 'nightly backup complete' "$work/out" || fail 'completion not logged'
grep -q "^label=${new##*/}$" "$work/last-nightly-success" || fail 'success marker missing or wrong'
grep -Eq '^completed_epoch=[0-9]+$' "$work/last-nightly-success" || fail 'success marker has no epoch'
[[ $(rows) -eq 2 ]] || fail 'expected a local and an offsite row'
grep -Eq 'b_step=local -v b_status=succeeded -v b_snapshot= -v b_bytes=[0-9]+ -v b_error=$' "$DOCKER_LOG" || fail 'local row wrong'
grep -Eq 'b_step=offsite -v b_status=succeeded -v b_snapshot=0123abcd4567 -v b_bytes=[0-9]+ -v b_error=$' "$DOCKER_LOG" || fail 'offsite row wrong'
echo 'nightly.sh checks passed.'
