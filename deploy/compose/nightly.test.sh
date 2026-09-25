#!/usr/bin/env bash
# Exercises nightly.sh with stub backup.sh and offsite.sh: step order, failure handling and local
# retention of nightly-* directories only. Nothing here touches Docker or R2.
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
[[ $1 != push || -z ${FAIL_PUSH:-} ]]
SH
if ! command -v flock >/dev/null; then printf '#!/usr/bin/env bash\nexit 0\n' > "$work/bin/flock"; fi
chmod +x "$work/bin/"* "$tools/"*.sh 2>/dev/null || true
conf=$work/release.conf
cat > "$conf" <<CONF
NIX_DEPLOY_ENV=$work/production.env
NIX_BACKUP_ROOT=$work/backups
NIX_RELEASE_LOCK=$work/release.lock
CONF
export PATH="$work/bin:$PATH" NIX_RELEASE_CONF="$conf" TEST_LOG="$work/calls"
fail() { echo "nightly.test: $*" >&2; exit 1; }
stamp() { python3 -c 'import datetime, sys
t = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=float(sys.argv[1]))
print(t.strftime("%Y%m%dT%H%M%SZ"))' "$1"; }

b=$work/backups
old=$b/nightly-$(stamp 8) recent=$b/nightly-$(stamp 6) ancient=$b/nightly-$(stamp 400)
mkdir "$old" "$recent" "$ancient" "$b/pre-1234567" "$b/nightly-manual" "$work/elsewhere"
touch -t 202001010000 "$b/pre-1234567"
ln -s "$work/elsewhere" "$b/nightly-$(stamp 30)"
link=$b/nightly-$(stamp 30)

# A failed push stops retention and keeps every local copy.
: > "$TEST_LOG"
if FAIL_PUSH=1 bash "$tools/nightly.sh" > "$work/out" 2>&1; then fail 'accepted a failed push'; fi
grep -q 'nightly: FAILED during off-host push' "$work/out" || fail 'failure not logged by step'
if grep -q '^offsite forget' "$TEST_LOG"; then fail 'forget ran after a failed push'; fi
[[ -d $old && -d $ancient ]] || fail 'local copies deleted after a failed push'

# A failed backup pushes nothing.
: > "$TEST_LOG"
if FAIL_BACKUP=1 bash "$tools/nightly.sh" > "$work/out" 2>&1; then fail 'accepted a failed backup'; fi
grep -q 'FAILED during local backup' "$work/out" || fail 'backup failure not logged'
if grep -q '^offsite' "$TEST_LOG"; then fail 'pushed after a failed backup'; fi

# Success: backup, push of the new directory, forget, then local retention.
sleep 1 # a distinct stamp from the directories the failed runs left behind
: > "$TEST_LOG"
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
echo 'nightly.sh checks passed.'
