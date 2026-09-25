#!/usr/bin/env bash
# Nightly backup for the Compose deployment, run by the nix-backup-nightly systemd user timer.
#
#   1. backup.sh --nightly            verified local backup in $NIX_BACKUP_ROOT/nightly-<UTC stamp>
#   2. offsite.sh push --tag kind=nightly
#   3. offsite.sh forget              repository retention
#   4. delete local nightly-* directories older than 7 days (never pre-* or anything else)
#
# Settings come from release.conf (NIX_RELEASE_CONF, default ~/nix-production/release.conf):
# NIX_DEPLOY_ENV, NIX_BACKUP_ROOT, NIX_RELEASE_LOCK and optionally NIX_NIGHTLY_MARKER. A complete
# run rewrites that marker (default ~/nix-production/last-nightly-success), which release.sh
# reads to warn when nightly backups have stopped succeeding. The host release lock is held throughout,
# so a nightly backup never overlaps a release. Any failure stops the later steps, logs the
# failed step to the journal and exits nonzero; local copies are only deleted after a
# successful push and retention run.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
keep_days=7
step=configuration

log() { printf 'nightly: %s\n' "$*" >&2; }
finish() {
  local status=$?
  if [[ $status -ne 0 ]]; then log "FAILED during $step (exit $status); later steps did not run"; fi
}
trap finish EXIT
die() { log "$*"; exit 1; }

[[ $# -eq 0 ]] || { echo 'usage: nightly.sh' >&2; exit 2; }
conf=${NIX_RELEASE_CONF:-$HOME/nix-production/release.conf}
[[ -f $conf ]] || die "release configuration not found: $conf"
# shellcheck source=/dev/null
source "$conf"
for key in NIX_DEPLOY_ENV NIX_BACKUP_ROOT; do
  [[ -n ${!key:-} ]] || die "$key is not set in $conf"
done
[[ $NIX_BACKUP_ROOT == /* ]] || die 'NIX_BACKUP_ROOT must be an absolute path'
export NIX_DEPLOY_ENV NIX_BACKUP_ROOT
lock=${NIX_RELEASE_LOCK:-$HOME/nix-release.lock}
marker=${NIX_NIGHTLY_MARKER:-$HOME/nix-production/last-nightly-success}

# A systemd user manager keeps the groups it started with, so a user added to `docker` later
# can reach the socket over SSH while the timer cannot. Say so, rather than a raw socket error.
step='docker access'
docker_error=$(docker info 2>&1 >/dev/null) || {
  if [[ $docker_error == *'permission denied'* ]] && ! id -Gn | tr ' ' '\n' | grep -qx docker; then
    die "this process is not in the docker group (it has: $(id -Gn)). If $(id -un) was added to docker after the systemd user manager started, run 'sudo systemctl restart user@$(id -u).service' or reboot."
  fi
  die "cannot reach Docker: ${docker_error%%$'\n'*}"
}

step='waiting for the release lock'
exec 9>>"$lock"
flock -w "${NIX_NIGHTLY_LOCK_WAIT:-3600}" 9 || die "the release lock $lock stayed held; no backup taken"

nightly_dirs() {
  find "$NIX_BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name 'nightly-*' 2>/dev/null | sort
}
step='local backup'
before=$(nightly_dirs)
log 'taking the local backup'
bash "$here/backup.sh" --nightly
dir=$(comm -13 <(printf '%s\n' "$before") <(nightly_dirs))
[[ -n $dir && $dir != *$'\n'* ]] || die 'could not identify the new nightly backup directory'

step='off-host push'
log "pushing $dir off-host"
bash "$here/offsite.sh" push "$dir" --tag kind=nightly

step='off-host retention'
bash "$here/offsite.sh" forget

step='local retention'
# Names carry their UTC creation time, so they compare as strings against the cutoff.
cutoff=$(python3 -c 'import datetime, sys
now = datetime.datetime.now(datetime.timezone.utc)
print((now - datetime.timedelta(days=int(sys.argv[1]))).strftime("%Y%m%dT%H%M%SZ"))' "$keep_days")
for old in "$NIX_BACKUP_ROOT"/nightly-*; do
  name=${old##*/}
  [[ -d $old && ! -L $old && $old != "$dir" ]] || continue
  [[ $name =~ ^nightly-[0-9]{8}T[0-9]{6}Z$ ]] || continue
  [[ ${name#nightly-} < "$cutoff" ]] || continue
  rm -rf -- "$old"
  log "deleted local $old (older than $keep_days days)"
done
step='success marker'
# Written last and atomically: its presence means every step above succeeded.
printf 'completed_epoch=%s\ncompleted_at=%s\nlabel=%s\n' "$(date -u +%s)" \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${dir##*/}" > "$marker.new"
mv -f "$marker.new" "$marker"
step=completion
log "nightly backup complete: $dir"
