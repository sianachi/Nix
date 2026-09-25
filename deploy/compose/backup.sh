#!/usr/bin/env bash
# Pre-release backup for the Compose deployment.
#
#   backup.sh <sha>          create and verify $NIX_BACKUP_ROOT/pre-<sha> (default ~/nix-backups)
#   backup.sh --check <dir>  exit 0 only for a complete backup whose restore verification passed
#
# Creation needs NIX_DEPLOY_ENV (absolute path to the private env file). Optional overrides:
# NIX_CORE_ACCESS_TOKEN_PEM, NIX_BACKUP_COMPOSE_FILE, NIX_BACKUP_CADDYFILE. Never deletes anything
# and never prints secrets: dumps, env and key copies go only to mode-600 files in a mode-700 dir.
set -euo pipefail

project=nix
pg_image=pgvector/pgvector:pg16
volumes=(nix-versity-data nix-api-data-protection nix-companion-data)
data_files=(nix.dump roles.sql nix-versity-data.tar nix-api-data-protection.tar nix-companion-data.tar
  env.private core-access-token.pem compose.prod.yml Caddyfile.prod containers.private.json)
row_count_tables=10

die() { echo "backup: $*" >&2; exit 1; }
usage() { echo 'usage: backup.sh <release-sha> | backup.sh --check <backup-dir>' >&2; exit 2; }

check_backup() {
  local dir=$1 name recorded actual
  [[ $dir == /* ]] || die "backup directory must be an absolute path: $dir"
  [[ -d $dir ]] || die "backup directory does not exist: $dir"
  for name in "${data_files[@]}" SHA256SUMS verified.txt; do
    [[ -f $dir/$name ]] || die "missing $name in $dir"
    [[ -s $dir/$name ]] || die "empty $name in $dir"
  done
  for name in "${data_files[@]}"; do
    awk -v f="$name" '{ sub(/^\*/, "", $2) } $2 == f { found=1 } END { exit !found }' "$dir/SHA256SUMS" \
      || die "SHA256SUMS does not cover $name"
  done
  (cd "$dir" && sha256sum --quiet -c SHA256SUMS >/dev/null 2>&1) \
    || die "SHA256SUMS verification failed in $dir"
  grep -qx 'result=passed' "$dir/verified.txt" \
    || die "verified.txt does not record a passed restore verification"
  recorded=$(sed -n 's/^sha256sums=//p' "$dir/verified.txt")
  actual=$(sha256sum < "$dir/SHA256SUMS" | cut -d' ' -f1)
  [[ -n $recorded && $recorded == "$actual" ]] \
    || die 'verified.txt was not written for this SHA256SUMS'
  python3 - "$dir" <<'PY' || die "backup is readable by group or others: $dir"
import os, stat, sys
d = sys.argv[1]
paths = [d] + [os.path.join(d, n) for n in os.listdir(d)]
sys.exit(1 if any(os.stat(p).st_mode & 0o077 for p in paths) else 0)
PY
  echo "backup verified: $dir"
}

if [[ ${1:-} == --check ]]; then
  [[ $# -eq 2 ]] || usage
  check_backup "$2"
  exit 0
fi
[[ $# -eq 1 && -n $1 && $1 != -* ]] || usage
sha=$1
[[ $sha =~ ^[0-9A-Za-z._-]+$ ]] || die 'release sha may contain only letters, digits, dot, dash and underscore'
: "${NIX_DEPLOY_ENV:?absolute path to the private production env file}"
[[ $NIX_DEPLOY_ENV == /* && -f $NIX_DEPLOY_ENV ]] || die 'NIX_DEPLOY_ENV must be an absolute path to a file'
command -v docker >/dev/null || die 'docker is required'
command -v sha256sum >/dev/null || die 'sha256sum is required'
command -v python3 >/dev/null || die 'python3 is required'

root=$(cd "$(dirname "$0")/../.." && pwd)
backup_root=${NIX_BACKUP_ROOT:-$HOME/nix-backups}
[[ $backup_root == /* ]] || die 'NIX_BACKUP_ROOT must be absolute'
dir=$backup_root/pre-$sha
umask 077

service_container() {
  local id
  id=$(docker ps -q --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=$1")
  [[ -n $id && $id != *$'\n'* ]] || die "expected exactly one running $1 container in project $project"
  echo "$id"
}
mount_source() {
  docker inspect --format "{{range .Mounts}}{{if eq .Destination \"$2\"}}{{.Source}}{{end}}{{end}}" "$1"
}

postgres=$(service_container postgres)
api=$(service_container nix-api)
versity=$(service_container nix-versitygw)
for vol in "${volumes[@]}"; do
  docker volume inspect "$vol" >/dev/null 2>&1 || die "volume $vol does not exist"
done
pem=${NIX_CORE_ACCESS_TOKEN_PEM:-$(mount_source "$api" /run/secrets/core-access-token.pem)}
[[ -n $pem && -f $pem ]] || die 'core access token pem not found; set NIX_CORE_ACCESS_TOKEN_PEM'
# Prefer the files the running stack was started from over this checkout's copies.
compose_file=${NIX_BACKUP_COMPOSE_FILE:-$(docker inspect --format \
  '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$api" | cut -d, -f1)}
[[ -f $compose_file ]] || compose_file=$root/deploy/compose.prod.yml
caddyfile=${NIX_BACKUP_CADDYFILE:-}
if [[ -z $caddyfile ]]; then
  caddy=$(docker ps -q --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=caddy" | head -n1)
  [[ -n $caddy ]] && caddyfile=$(mount_source "$caddy" /etc/caddy/Caddyfile)
  [[ -f $caddyfile ]] || caddyfile=$(dirname "$compose_file")/Caddyfile.prod
fi
[[ -f $compose_file && -f $caddyfile ]] || die 'compose or Caddy file not found; set NIX_BACKUP_COMPOSE_FILE/NIX_BACKUP_CADDYFILE'

[[ -e $dir ]] && die "$dir already exists; refusing to overwrite it (choose another NIX_BACKUP_ROOT)"
mkdir -p "$backup_root"
mkdir -m 700 "$dir"

paused='' verify_container=''
cleanup() {
  if [[ -n $paused ]]; then docker unpause "$paused" >/dev/null || echo "backup: UNPAUSE $paused MANUALLY" >&2; fi
  if [[ -n $verify_container ]]; then docker rm -f "$verify_container" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

echo "backup: writing $dir"
docker exec "$postgres" pg_dump -U postgres -Fc nix > "$dir/nix.dump"
docker exec "$postgres" pg_dumpall -U postgres --roles-only > "$dir/roles.sql"
archive_volume() {
  docker run --rm --network none -v "$1:/data:ro" "$pg_image" tar -C /data -cf - . > "$dir/$1.tar"
}
archive_volume nix-api-data-protection
archive_volume nix-companion-data
# Versity must not change while archived; the EXIT trap unpauses it on any failure.
docker pause "$versity" >/dev/null
paused=$versity
archive_volume nix-versity-data
docker unpause "$versity" >/dev/null
paused=''
cp "$NIX_DEPLOY_ENV" "$dir/env.private"
cp "$pem" "$dir/core-access-token.pem"
cp "$compose_file" "$dir/compose.prod.yml"
cp "$caddyfile" "$dir/Caddyfile.prod"
# shellcheck disable=SC2046 # one argument per container id
docker inspect $(docker ps -aq --filter "label=com.docker.compose.project=$project") > "$dir/containers.private.json"
chmod 600 "$dir"/*
(cd "$dir" && sha256sum -- "${data_files[@]}" > SHA256SUMS && chmod 600 SHA256SUMS)
(cd "$dir" && sha256sum --quiet -c SHA256SUMS)

echo 'backup: restoring into an isolated container'
failures=() warnings=() report=()
verify_container=nix-backup-verify-$sha-$$
docker run -d --name "$verify_container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust \
  "$pg_image" >/dev/null
for _ in $(seq 1 60); do
  # The entrypoint's init server listens only on the socket; TCP means the final server is up.
  docker exec "$verify_container" pg_isready -q -h 127.0.0.1 -U postgres && break
  sleep 1
done
docker exec "$verify_container" pg_isready -q -h 127.0.0.1 -U postgres || die 'verify container did not start'
# The postgres role already exists in a fresh cluster; everything else must apply cleanly.
grep -vx 'CREATE ROLE postgres;' "$dir/roles.sql" \
  | docker exec -i "$verify_container" psql -q -X -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null
docker exec "$verify_container" createdb -U postgres nix
docker exec -i "$verify_container" pg_restore -U postgres -d nix --exit-on-error < "$dir/nix.dump"

live_sql() { docker exec "$postgres" psql -X -At -U postgres -d nix -c "$1"; }
restored_sql() { docker exec "$verify_container" psql -X -At -U postgres -d nix -c "$1"; }
table_count_sql="SELECT count(*) FROM pg_stat_user_tables"
live_tables=$(live_sql "$table_count_sql")
restored_tables=$(restored_sql "$table_count_sql")
report+=("tables live=$live_tables restored=$restored_tables")
[[ $live_tables == "$restored_tables" ]] || failures+=("table count live=$live_tables restored=$restored_tables")
while IFS= read -r table; do
  [[ -n $table ]] || continue
  live=$(live_sql "SELECT count(*) FROM $table")
  restored=$(restored_sql "SELECT count(*) FROM $table")
  report+=("rows $table live=$live restored=$restored")
  [[ $live == "$restored" ]] || failures+=("rows $table live=$live restored=$restored")
done < <(live_sql "SELECT format('%I.%I', schemaname, relname) FROM pg_stat_user_tables
  ORDER BY n_live_tup DESC, 1 LIMIT $row_count_tables")

archive_entries() {
  python3 - "$1" <<'PY'
import sys, tarfile
with tarfile.open(sys.argv[1]) as t:
    print(sum(1 for m in t if m.name.rstrip('/') not in ('', '.')))
PY
}
for vol in "${volumes[@]}"; do
  live=$(docker run --rm --network none -v "$vol:/data:ro" "$pg_image" sh -c 'find /data -mindepth 1 | wc -l' | tr -d ' ')
  archived=$(archive_entries "$dir/$vol.tar")
  report+=("files $vol live=$live archived=$archived")
  [[ $live == "$archived" ]] && continue
  diff=$(( live > archived ? live - archived : archived - live ))
  # Companion data changes constantly; tolerate small drift there only.
  if [[ $vol == nix-companion-data ]] && (( diff <= 10 || diff * 20 <= live )); then
    warnings+=("files $vol live=$live archived=$archived")
  else
    failures+=("files $vol live=$live archived=$archived")
  fi
done

result=passed
(( ${#failures[@]} == 0 )) || result=failed
{
  echo "result=$result"
  echo "verified_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "release=$sha"
  echo "sha256sums=$(sha256sum < "$dir/SHA256SUMS" | cut -d' ' -f1)"
  for line in "${report[@]}"; do echo "check $line"; done
  for line in "${warnings[@]+"${warnings[@]}"}"; do echo "warning $line"; done
  for line in "${failures[@]+"${failures[@]}"}"; do echo "failure $line"; done
} > "$dir/verified.txt"
chmod 600 "$dir/verified.txt"
for line in "${warnings[@]+"${warnings[@]}"}"; do echo "backup: warning: $line" >&2; done
if [[ $result != passed ]]; then
  for line in "${failures[@]}"; do echo "backup: failure: $line" >&2; done
  die "verification failed; $dir is kept for inspection (row drift means writers were active)"
fi
check_backup "$dir"
