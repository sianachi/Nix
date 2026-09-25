#!/usr/bin/env bash
# Exercises prune.sh against a stubbed docker and a fixture home directory.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
mkdir "$fixture/bin"
cat > "$fixture/bin/docker" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *'volume'*|*' rm '*|*'prune'*) echo "destructive docker call: $*" >&2; exit 9 ;;
  'ps '*'com.docker.compose.service=nix-api'*) [ -z "${PRUNE_API_IMAGE:-}" ] || echo "$PRUNE_API_IMAGE" ;;
  'ps -a '*) echo "${PRUNE_IN_USE:-}" ;;
  *) echo "unexpected docker call: $*" >&2; exit 9 ;;
esac
STUB
chmod +x "$fixture/bin/docker"
home="$fixture/home"
export PATH="$fixture/bin:$PATH" NIX_PRUNE_HOME="$home"
fail() { echo "prune.test: $*" >&2; exit 1; }
prune() { bash "$root/deploy/compose/prune.sh" "$@"; }

# Releases oldest to newest; 44444444 runs, 55555555 is staged next.
mkdir -p "$home/nix-backups" "$home/nix-production"
n=1
for id in 11111111 22222222 33333333 44444444 55555555; do
  mkdir "$home/nix-release-$id"; touch -t "20260${n}010000" "$home/nix-release-$id"
  mkdir "$home/nix-backups/pre-$id"; touch -t "20260${n}020000" "$home/nix-backups/pre-$id"
  n=$((n + 1))
done
mkdir "$home/nix-backups/pre-legacy"; touch -t 202512010000 "$home/nix-backups/pre-legacy"
# An old backup whose name ties it to the previous release is kept despite its age.
mkdir "$home/nix-backups/pre-33333333-manual"; touch -t 202501010000 "$home/nix-backups/pre-33333333-manual"
ln -s "$home/nix-production" "$home/nix-release-link"
touch -t 202001010000 "$home/nix-production"
export PRUNE_API_IMAGE=ghcr.io/sianachi/nix/api:4444444412345678901234567890123456789012
# The oldest checkout still labels a running container (the old-override case).
export PRUNE_IN_USE="$home/nix-release-11111111/deploy,$home/nix-release-11111111/deploy/compose.host.yml"

prune > "$fixture/dry"
grep -q "^delete  $home/nix-release-22222222 " "$fixture/dry" || fail 'old release not proposed'
grep -q "^delete  $home/nix-backups/pre-11111111 " "$fixture/dry" || fail 'old backup not proposed'
grep -q "^delete  $home/nix-backups/pre-legacy " "$fixture/dry" || fail 'old unnamed backup not proposed'
grep -q "^keep    $home/nix-release-44444444 (current release)" "$fixture/dry" || fail 'current not kept'
grep -q "^keep    $home/nix-release-33333333 (previous release)" "$fixture/dry" || fail 'previous not kept'
grep -q "^keep    $home/nix-release-55555555 (newer" "$fixture/dry" || fail 'newer not kept'
grep -q "^keep    $home/nix-release-11111111 (used by a running container)" "$fixture/dry" || fail 'in-use not kept'
grep -q 'would be deleted' "$fixture/dry" || fail 'dry run not reported'
[ -d "$home/nix-release-22222222" ] && [ -d "$home/nix-backups/pre-11111111" ] || fail 'dry run deleted'
if grep -q 'nix-production\|nix-release-link' "$fixture/dry"; then fail 'listed production or a symlink'; fi

prune --apply > "$fixture/apply"
for gone in nix-release-22222222 nix-backups/pre-11111111 nix-backups/pre-22222222 nix-backups/pre-legacy; do
  [ ! -e "$home/$gone" ] || fail "$gone survived --apply"
done
for kept in nix-release-11111111 nix-release-33333333 nix-release-44444444 nix-release-55555555 \
  nix-backups/pre-33333333 nix-backups/pre-33333333-manual nix-backups/pre-44444444 \
  nix-backups/pre-55555555 nix-production nix-release-link; do
  [ -e "$home/$kept" ] || fail "$kept was deleted"
done
grep -q 'deleted 4 path(s)' "$fixture/apply" || fail 'apply count wrong'

# Unknown running release, or none: refuse and delete nothing.
PRUNE_API_IMAGE=ghcr.io/sianachi/nix/api:9999999999 prune --apply > "$fixture/unknown" 2>&1 && fail 'accepted unknown release'
PRUNE_API_IMAGE='' prune --apply > "$fixture/none" 2>&1 && fail 'accepted no running release'
[ -d "$home/nix-release-11111111" ] || fail 'refusal deleted'
prune --force > /dev/null 2>&1 && fail 'accepted an unknown option'
echo 'prune.sh checks passed.'
