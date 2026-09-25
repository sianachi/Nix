#!/usr/bin/env bash
# Exercise release.sh validation, image checks and ledger records with stubbed docker, git,
# backup.sh and deploy.sh. Nothing here touches Docker, a registry or a real host.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
sha=0123456789abcdef0123456789abcdef01234567
other=fedcba9876543210fedcba9876543210fedcba98

# A throwaway release tree: the real release.sh beside stub backup.sh and deploy.sh.
tree="$fixture/tree"
mkdir -p "$tree/deploy/compose" "$fixture/bin" "$fixture/home/nix-production"
cp "$here/release.sh" "$tree/deploy/compose/release.sh"
: > "$tree/deploy/compose.prod.yml"
cat > "$tree/deploy/compose/backup.sh" <<'SH'
#!/usr/bin/env bash
echo "backup $*" >> "$TEST_LOG"
if [[ "$1" == --check ]]; then [[ -d "$2" ]]; else mkdir -p "$NIX_BACKUP_ROOT/pre-$1"; fi
SH
cat > "$tree/deploy/compose/deploy.sh" <<'SH'
#!/usr/bin/env bash
echo "deploy tag=$NIX_IMAGE_TAG web=$NIX_WEB_IMAGE_TAG backup=$NIX_BACKUP_REFERENCE" >> "$TEST_LOG"
[[ -z "${FAIL_DEPLOY:-}" ]]
SH
cat > "$fixture/bin/git" <<'SH'
#!/usr/bin/env bash
case "$*" in
  *'rev-parse HEAD') echo "$TEST_HEAD" ;;
  *'diff --quiet HEAD --') exit 0 ;;
  *) exit 1 ;;
esac
SH
# Compose resolves images from the exported tags, as real interpolation does.
cat > "$fixture/bin/docker" <<'SH'
#!/usr/bin/env bash
echo "docker $*" >> "$TEST_LOG"
case "$*" in
  *'config --images')
    for name in api migrator collab worker; do echo "$NIX_IMAGE_REGISTRY/$name:$NIX_IMAGE_TAG"; done
    echo "$NIX_IMAGE_REGISTRY/web:$NIX_WEB_IMAGE_TAG"
    echo 'rabbitmq:4.1-management-alpine' ;;
  'manifest inspect '*) [[ "$3" != "${MISSING_IMAGE:-none}" ]] ;;
  *) exit 1 ;;
esac
SH
if ! command -v flock >/dev/null; then
  printf '#!/usr/bin/env bash\nexit 0\n' > "$fixture/bin/flock"
fi
chmod +x "$fixture/bin/"* "$tree/deploy/compose/"*.sh

conf="$fixture/home/nix-production/release.conf"
ledger="$fixture/home/nix-production/releases.tsv"
: > "$fixture/production.env"
cat > "$conf" <<CONF
NIX_DEPLOY_ENV=$fixture/production.env
NIXCTL_PROFILE=production
NIX_SMOKE_WORKSPACE=smoke-workspace
NIX_BACKUP_ROOT=$fixture/backups
NIX_RELEASE_LEDGER=$ledger
NIX_RELEASE_LOCK=$fixture/release.lock
NIX_IMAGE_REGISTRY=ghcr.io/sianachi/nix
CONF

export PATH="$fixture/bin:$PATH" HOME="$fixture/home" TEST_LOG="$fixture/calls" TEST_HEAD="$sha" USER=tester
unset NIX_RELEASE_CONF NIX_BACKUP_REFERENCE NIX_IMAGE_TAG NIX_WEB_IMAGE_TAG MISSING_IMAGE FAIL_DEPLOY
release() { bash "$tree/deploy/compose/release.sh" "$@" > "$fixture/out" 2>&1 < /dev/null; }
refuses() { # expected-message args...
  local expected=$1; shift
  : > "$TEST_LOG"
  if release "$@"; then echo "release.sh accepted: $*" >&2; exit 1; fi
  grep -q -- "$expected" "$fixture/out" || { echo "missing '$expected' in:" >&2; cat "$fixture/out" >&2; exit 1; }
  if grep -Eq '^(backup|deploy)' "$TEST_LOG"; then echo "release.sh acted before refusing: $*" >&2; exit 1; fi
  [[ ! -e "$ledger" ]] || { echo 'refused release wrote the ledger' >&2; exit 1; }
}

refuses 'full lowercase 40-character' --yes 0123456789ab
refuses 'full lowercase 40-character' --yes "$(printf %s "$sha" | tr a-f A-F)"
refuses 'full lowercase 40-character' --yes "${sha}0"
refuses 'usage:' --yes
TEST_HEAD=$other refuses "checkout HEAD is $other" --yes "$sha"
NIX_RELEASE_CONF="$fixture/absent.conf" refuses 'release configuration not found' --yes "$sha"
MISSING_IMAGE="ghcr.io/sianachi/nix/worker:$sha" refuses "image not published: ghcr.io/sianachi/nix/worker:$sha" --yes "$sha"
NIX_BACKUP_REFERENCE="$fixture/no-such-backup" refuses 'not an existing directory' --yes "$sha"
refuses 'without --yes' "$sha"

# Success: backup is taken and checked, tags reach deploy.sh from the environment, ledger records it.
: > "$TEST_LOG"
release --yes "$sha" || { cat "$fixture/out" >&2; exit 1; }
grep -qx "backup $sha" "$TEST_LOG"
grep -qx "backup --check $fixture/backups/pre-$sha" "$TEST_LOG"
grep -qx "deploy tag=$sha web=$sha backup=$fixture/backups/pre-$sha" "$TEST_LOG"
[[ $(wc -l < "$ledger") -eq 1 ]]
IFS=$'\t' read -r when got_sha got_backup got_result got_operator < "$ledger"
[[ "$when" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z$ ]]
[[ "$got_sha" == "$sha" && "$got_backup" == "$fixture/backups/pre-$sha" ]]
[[ "$got_result" == succeeded && "$got_operator" == operator=tester ]]
grep -q '^NIX_IMAGE_TAG' "$fixture/production.env" && { echo 'secrets file was edited' >&2; exit 1; }

# Failure: an existing checked backup is reused, and the failed deploy is still recorded.
: > "$TEST_LOG"
if NIX_BACKUP_REFERENCE="$fixture/backups/pre-$sha" FAIL_DEPLOY=1 release --yes "$sha"; then
  echo 'release.sh reported success for a failed deploy' >&2; exit 1
fi
if grep -qx "backup $sha" "$TEST_LOG"; then echo 'release.sh took a second backup' >&2; exit 1; fi
[[ $(wc -l < "$ledger") -eq 2 ]]
tail -n 1 "$ledger" | grep -q $'\t'"$sha"$'\t'"$fixture/backups/pre-$sha"$'\tfailed:deploy\toperator=tester$'
echo 'Release argument, configuration, image and ledger checks passed.'
