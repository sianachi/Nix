#!/usr/bin/env bash
# Exercises `backup.sh --check` against fixture directories, and a whole `backup.sh` run
# (release and nightly, with and without Zitadel) against a stubbed docker. Needs no Docker.
#   backup.test.sh                 run the checks
#   backup.test.sh --fixture DIR   only write a valid fixture backup to DIR (used by check.test.sh)
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
backup=$root/deploy/compose/backup.sh

# make_fixture DIR [--zitadel]: without --zitadel it matches backups made before Zitadel capture.
make_fixture() {
  local dir=$1 name names
  names=(nix.dump roles.sql nix-versity-data.tar nix-api-data-protection.tar nix-companion-data.tar
    env.private core-access-token.pem compose.prod.yml Caddyfile.prod containers.private.json)
  if [[ ${2:-} == --zitadel ]]; then names+=(zitadel.dump zitadel-roles.sql); fi
  mkdir -m 700 "$dir"
  for name in "${names[@]}"; do
    printf 'fixture %s\n' "$name" > "$dir/$name"
  done
  (cd "$dir" && sha256sum -- * > SHA256SUMS)
  {
    echo 'result=passed'
    echo 'verified_at=2026-01-01T00:00:00Z'
    echo 'release=fixture'
    if [[ ${2:-} == --zitadel ]]; then echo 'zitadel=verified'; fi
    echo "sha256sums=$(sha256sum < "$dir/SHA256SUMS" | cut -d' ' -f1)"
  } > "$dir/verified.txt"
  chmod 600 "$dir"/*
}

if [[ ${1:-} == --fixture ]]; then
  [[ $# -eq 2 ]] || { echo 'usage: backup.test.sh --fixture DIR' >&2; exit 2; }
  make_fixture "$2"
  exit 0
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
chmod 700 "$work"

expect_fail() {
  local label=$1 pattern=$2 dir=$3
  if bash "$backup" --check "$dir" > "$work/out" 2>&1; then
    echo "backup --check accepted: $label" >&2; exit 1
  fi
  grep -q -- "$pattern" "$work/out" || { echo "unclear rejection for $label:" >&2; cat "$work/out" >&2; exit 1; }
}

make_fixture "$work/valid"
bash "$backup" --check "$work/valid" > "$work/out"
grep -q 'backup verified' "$work/out"
# A backup made before Zitadel capture stays valid, and the check says what it lacks.
grep -q 'note: no zitadel dump' "$work/out"
if NIX_REQUIRE_ZITADEL=1 bash "$backup" --check "$work/valid" > "$work/out" 2>&1; then
  echo 'backup --check accepted a backup without zitadel under NIX_REQUIRE_ZITADEL=1' >&2; exit 1
fi

make_fixture "$work/with-zitadel" --zitadel
NIX_REQUIRE_ZITADEL=1 bash "$backup" --check "$work/with-zitadel" > "$work/out"
grep -q 'backup verified' "$work/out"
if grep -q 'note:' "$work/out"; then echo 'zitadel backup reported as missing zitadel' >&2; exit 1; fi

make_fixture "$work/half-zitadel" --zitadel
rm "$work/half-zitadel/zitadel-roles.sql"
expect_fail 'half a zitadel backup' 'incomplete zitadel backup' "$work/half-zitadel"

make_fixture "$work/zitadel-unverified" --zitadel
grep -v '^zitadel=' "$work/zitadel-unverified/verified.txt" > "$work/v" && cat "$work/v" > "$work/zitadel-unverified/verified.txt"
expect_fail 'unverified zitadel restore' 'verified zitadel restore' "$work/zitadel-unverified"

make_fixture "$work/zitadel-uncovered" --zitadel
grep -v ' zitadel.dump$' "$work/zitadel-uncovered/SHA256SUMS" > "$work/sums" && cat "$work/sums" > "$work/zitadel-uncovered/SHA256SUMS"
expect_fail 'zitadel dump missing from SHA256SUMS' 'does not cover zitadel.dump' "$work/zitadel-uncovered"

make_fixture "$work/bad-checksum"
printf 'tampered\n' >> "$work/bad-checksum/nix.dump"
expect_fail 'bad checksum' 'SHA256SUMS verification failed' "$work/bad-checksum"

make_fixture "$work/no-verified"
rm "$work/no-verified/verified.txt"
expect_fail 'missing verified.txt' 'missing verified.txt' "$work/no-verified"

make_fixture "$work/failed-restore"
sed -i.orig 's/^result=passed$/result=failed/' "$work/failed-restore/verified.txt"
rm "$work/failed-restore/verified.txt.orig"
expect_fail 'failed restore' 'passed restore' "$work/failed-restore"

make_fixture "$work/missing-dump"
rm "$work/missing-dump/nix.dump"
expect_fail 'missing dump' 'missing nix.dump' "$work/missing-dump"

make_fixture "$work/uncovered"
grep -v ' roles.sql$' "$work/uncovered/SHA256SUMS" > "$work/sums" && cat "$work/sums" > "$work/uncovered/SHA256SUMS"
expect_fail 'file missing from SHA256SUMS' 'does not cover roles.sql' "$work/uncovered"

make_fixture "$work/readable"
chmod 644 "$work/readable/env.private"
expect_fail 'group-readable secret' 'readable by group or others' "$work/readable"

expect_fail 'relative path' 'absolute path' valid
expect_fail 'absent directory' 'does not exist' "$work/absent"

if bash "$backup" > "$work/out" 2>&1; then echo 'backup.sh ran without arguments' >&2; exit 1; fi
if NIX_BACKUP_ROOT="$work" NIX_DEPLOY_ENV="$work/valid/env.private" bash "$backup" '../escape' > "$work/out" 2>&1; then
  echo 'backup.sh accepted a path-like release sha' >&2; exit 1
fi
if bash "$backup" --nightly extra > "$work/out" 2>&1; then echo 'backup.sh --nightly accepted an argument' >&2; exit 1; fi

# Whole runs against a stubbed docker: the snapshot session, dumps, archives and both isolated
# restores are simulated; the script's own sequencing, files and verification record are real.
mkdir "$work/bin" "$work/run"
cat > "$work/bin/docker" <<'STUB'
#!/usr/bin/env python3
import io, os, sys, tarfile
args = sys.argv[1:]
with open(os.environ['BACKUP_DOCKER_LOG'], 'a') as log:
    log.write(' '.join(args) + '\n')
line = ' '.join(args)
zitadel = os.environ.get('STUB_ZITADEL') == '1'
out = sys.stdout.write

def sql_reply(sql):
    sql = sql.strip().rstrip(';')
    if 'pg_export_snapshot' in sql: return '00000003-0000001B-1'
    if sql == 'SELECT count(*) FROM pg_stat_user_tables': return '2'
    if 'format(' in sql: return 'public.items\npublic.events'
    if "'end-of-tables'" in sql: return 'end-of-tables'
    if sql.startswith('SELECT count(*) FROM public.items'): return '7'
    if sql.startswith('SELECT count(*) FROM public.events'): return '11'
    return None

if args[0] == 'ps':
    if 'label=com.docker.compose.project=zitadel' in line:
        if zitadel: out('z-db db\nz-app zitadel\n')
    elif '-aq' in args: out('c-postgres\nc-nix-api\n')
    else:
        service = [a for a in args if a.startswith('label=com.docker.compose.service=')]
        if service and service[0].endswith('caddy'): pass
        elif service: out('c-' + service[0].split('=', 2)[2] + '\n')
elif args[0] == 'volume': pass
elif args[0] == 'inspect':
    if '{{.Config.Image}}' in line: out('postgres:17-alpine\n')
    else: out('[]\n')
elif args[0] in ('pause', 'unpause', 'rm'): pass
elif args[0] == 'run':
    if '-d' in args: out('container-id\n')
    elif 'tar' in args:
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode='w') as t:
            for name in ('a', 'b'):
                data = b'x'
                info = tarfile.TarInfo('./' + name); info.size = len(data)
                t.addfile(info, io.BytesIO(data))
        sys.stdout.buffer.write(buf.getvalue())
    elif 'sh' in args: out('2\n')
elif args[0] == 'exec':
    target = args[2] if args[1] == '-i' else args[1]
    rest = args[3:] if args[1] == '-i' else args[2:]
    tool = rest[0]
    if tool == 'psql' and '-c' not in rest and target == 'c-postgres':
        pending = ''
        for raw in sys.stdin:
            pending += raw
            if not raw.rstrip().endswith(';'): continue
            reply = sql_reply(pending); pending = ''
            if reply is not None:
                out(reply + '\n'); sys.stdout.flush()
    elif tool == 'psql' and '-c' in rest:
        sql = rest[rest.index('-c') + 1]
        if target.startswith('nix-backup-verify-zitadel-'):
            if 'pg_database' in sql: pass
            else: out(os.environ.get('STUB_ZITADEL_RESTORED', '5') + '\n')
        elif target == 'z-db': out('5\n')
        else: out(sql_reply(sql) + '\n')
    elif tool == 'psql': sys.stdin.read()
    elif tool == 'pg_restore': sys.stdin.read()
    elif tool == 'pg_dump': out('dump of %s\n' % rest[-1])
    elif tool == 'pg_dumpall': out('CREATE ROLE postgres;\nCREATE ROLE %s;\n' % target)
    elif tool in ('pg_isready', 'createdb'): pass
    else: sys.exit('unexpected exec: ' + line)
else:
    sys.exit('unexpected docker call: ' + line)
STUB
chmod +x "$work/bin/docker"
for name in env pem compose caddy; do printf 'fixture %s\n' "$name" > "$work/run/$name"; done
run_backup() {
  PATH="$work/bin:$PATH" BACKUP_DOCKER_LOG="$work/docker.log" NIX_BACKUP_ROOT="$work/run/backups" \
    NIX_DEPLOY_ENV="$work/run/env" NIX_CORE_ACCESS_TOKEN_PEM="$work/run/pem" \
    NIX_BACKUP_COMPOSE_FILE="$work/run/compose" NIX_BACKUP_CADDYFILE="$work/run/caddy" \
    bash "$backup" "$@"
}

# Release run with Zitadel: both dumps are summed, restored in their own containers and checked.
: > "$work/docker.log"
STUB_ZITADEL=1 run_backup 1234567 > "$work/out" 2>&1 || { cat "$work/out" >&2; exit 1; }
dir=$work/run/backups/pre-1234567
for name in zitadel.dump zitadel-roles.sql; do
  grep -q " $name\$" "$dir/SHA256SUMS" || { echo "SHA256SUMS lacks $name" >&2; exit 1; }
done
grep -qx 'zitadel=verified' "$dir/verified.txt"
grep -qx 'release=1234567' "$dir/verified.txt"
grep -qx 'check zitadel tables live=5 restored=5' "$dir/verified.txt"
grep -q 'run -d --name nix-backup-verify-zitadel-1234567-[0-9]* --network none .* postgres:17-alpine$' "$work/docker.log"
grep -q '^exec -i nix-backup-verify-zitadel-1234567-[0-9]* pg_restore -U postgres -d zitadel' "$work/docker.log"
[[ $(grep -c '^rm -f nix-backup-verify-' "$work/docker.log") -eq 2 ]] || { echo 'verify containers not removed' >&2; exit 1; }
NIX_REQUIRE_ZITADEL=1 bash "$backup" --check "$dir" > /dev/null

# Nightly run without Zitadel: a warning, a labelled directory and an absent zitadel record.
: > "$work/docker.log"
run_backup --nightly > "$work/out" 2>&1 || { cat "$work/out" >&2; exit 1; }
grep -q 'warning: no running zitadel database container' "$work/out"
nightly=$(find "$work/run/backups" -mindepth 1 -maxdepth 1 -name 'nightly-*')
[[ ${nightly##*/} =~ ^nightly-[0-9]{8}T[0-9]{6}Z$ ]] || { echo "unexpected nightly directory: $nightly" >&2; exit 1; }
grep -qx 'kind=nightly' "$nightly/verified.txt"
grep -qx 'zitadel=absent' "$nightly/verified.txt"
[[ ! -e $nightly/zitadel.dump ]]
bash "$backup" --check "$nightly" > /dev/null

# Required but absent Zitadel stops before anything is written; a bad Zitadel restore fails.
if NIX_REQUIRE_ZITADEL=1 run_backup 7654321 > "$work/out" 2>&1; then
  echo 'backup.sh ran without zitadel under NIX_REQUIRE_ZITADEL=1' >&2; exit 1
fi
[[ ! -e $work/run/backups/pre-7654321 ]] || { echo 'refused backup left a directory' >&2; exit 1; }
if STUB_ZITADEL=1 STUB_ZITADEL_RESTORED=4 run_backup 7654322 > "$work/out" 2>&1; then
  echo 'backup.sh accepted a zitadel restore with missing tables' >&2; exit 1
fi
grep -qx 'failure zitadel tables live=5 restored=4' "$work/run/backups/pre-7654322/verified.txt"
echo 'Backup check passed for valid fixtures (with and without zitadel) and rejected damaged ones.'
