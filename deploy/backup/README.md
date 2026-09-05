# Local Nix backups to R2

Status, 5 September 2026: this helper is included in the repository. This document does
not establish that a backup schedule is installed or a remote backup/restore has succeeded.
See [repository recovery scope](../../docs/operations.md).

`scripts/backup-r2.py` backs up the local Docker deployment using restic. It includes
Nix and Zitadel logical database dumps, database roles, the Versity attachment
volume and configured recovery files. It does not back up live PostgreSQL data
files. Dumps are uncompressed so restic can deduplicate and compress them.

Copy `config.example.json` to a private directory outside the repository and set
absolute paths. Restrict configuration and credentials to mode 600. The R2
credentials file uses Docker env-file syntax:

```
AWS_ACCESS_KEY_ID=your-bucket-scoped-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
```

Use R2 Object Read & Write credentials scoped to `nix-backup`. The repository is
under `restic/nix-local` so unrelated objects in the bucket are untouched. Generate
a strong random restic password in a separate private file and save a copy in a
password manager before relying on these backups. Never regenerate that password
for an existing repository.

Run with Python 3 and Docker available:

```
python3 scripts/backup-r2.py --config /private/path/config.json init
python3 scripts/backup-r2.py --config /private/path/config.json backup
python3 scripts/backup-r2.py --config /private/path/config.json check
python3 scripts/backup-r2.py --config /private/path/config.json snapshots
python3 scripts/backup-r2.py --config /private/path/config.json restore --target /empty/restore-directory
```

Initialize only once. Backups fail if the repository is unavailable; they do not
initialize a replacement. Retention runs only after a successful backup and
repository check, keeping 7 daily and 4 weekly snapshots. Incomplete snapshots are
marked pending and excluded from the default restore and retention selection.
They may remain until inspected and explicitly removed. Each successful backup
writes `last-success.txt` in the state directory. Logs must be monitored for
failures. The full `check` command reads and validates all stored data.

On macOS, schedule the backup command with launchd at 02:00 local time. Docker
must be running and the user session available; a sleeping Mac runs a calendar job
after waking. A powered-off or logged-out Mac cannot provide an always-on backup
schedule. Validate an actual R2 backup before enabling the job.

Restoring extracts files without touching the running application. `backup/`
contains dumps, roles and recovery files; `objects/` contains the Versity volume
contents. Rebuild the matching PostgreSQL 16/pgvector and Zitadel deployment in
isolation, restore each cluster's roles and database with `psql`/`pg_restore`, then
restore the object volume and original configuration/keys before starting Nix.
Archive readability and restic file verification do not substitute for an
application-level disaster-recovery rehearsal.

These are independent database snapshots followed by a live object-volume read.
They are not an atomic cross-service snapshot: avoid attachment garbage collection
during capture. Use an application maintenance window when an exact coordinated
recovery point is required. PostgreSQL role dumps contain sensitive password
hashes; all staging is private, temporary and uploaded only through encryption.
