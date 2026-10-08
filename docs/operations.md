# Operations and recovery

## Deployment entry points

Development uses `scripts/dev-stack-up.sh` plus four host processes described in the README; the
calendar, notify and speech worker roles are opt-in there. Docker Compose is the default
production target; follow [the production runbook](../deploy/README.md). Production templates
live in `deploy/compose.prod.yml`, `deploy/compose.prod.env.example` and `deploy/k8s/`. Images
are built by CI for every `main` commit and published to `ghcr.io/sianachi/nix` tagged with the
full SHA; a release is `deploy/compose/release.sh <sha>` on the host. Inspect
`deploy/k8s/deploy.sh`, `create-secrets.sh` and `verify.sh` before use; these scripts mutate
deployment state. This documentation refresh did not deploy or verify a cluster.

Core owns authorization, Postgres mutations and object capabilities. Collaboration owns editable
CRDT bodies, document history and the `.nix` archive. One Go worker binary runs the roles import,
export, index, plugin-events, calendar, notify and speech, selected by `NIX_WORKER_ROLES`; the
production Compose manifest runs one container per role, with speech behind the optional `speech`
profile. Workers use RabbitMQ and internal APIs, never database credentials. OpenSearch is
rebuildable derived state. The Kubernetes manifests deploy a single worker deployment and are
retained rather than maintained as the release path.

Keep worker role credentials, Core signing keys, BFF data-protection keys, database credentials and
identity-provider recovery material private. File bytes use private object storage directly through
short-lived capabilities. Database restoration alone cannot restore file-backed documents.

## Backup scope

`deploy/k8s/backup.yaml` schedules a nightly logical dump of the Nix database into a PVC.
It does not itself back up object storage, Zitadel, cluster roles or application keys, and a local
PVC is not independent disaster-recovery storage. Preserve all those authoritative resources.
Closure, snapshots, search, links and embeddings are derived and can be rebuilt from durable data.
The speech models volume is not backed up; it is rebuilt from `deploy/speech/models.sha256` with
`deploy/compose/speech-models.sh`. The companion data volume holds bounded private companion
state and provider sessions.

The repository also contains [a local restic-to-R2 helper](../deploy/backup/README.md) and
`scripts/backup-r2.py`. It includes database dumps, roles, the Versity volume and configured recovery
files. Its presence does not mean a schedule is installed, a remote backup succeeded, or a restore
has been rehearsed. Follow its configuration and consistency limitations before relying on it.

Rehearse recovery into an isolated environment using matching database and identity versions,
original keys and object data. Verify sign-in, permissions, document editing and attachment access
through supported clients. Record actual recovery time and data loss; do not infer success from
archive readability. Postgres outbox recovery and the scheduler's leased jobs also need
verification after a restore.

## Known implementation limits

Uploads are inspected by the worker before publication (size, expiry, digest, media type,
previews) but are not malware-scanned; see the
[known deviations](README.md#known-deviations-from-accepted-design). Import handlers cover
Markdown, TXT, DOCX, PDF and `.nix`; PDF OCR is unavailable. Calendar sync polls providers rather
than subscribing to change notifications. The speech role needs a host with the models volume
filled and, for the default image, an NVIDIA runtime. Production fidelity, failure recovery,
large imports, device behavior and resource limits need their own observed evidence.
