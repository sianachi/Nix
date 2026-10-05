# Operations and recovery

## Deployment entry points

Development uses `scripts/dev-stack-up.sh` plus four host processes described in the README.
Docker Compose is the default production target; follow [the production runbook](../deploy/README.md). Production templates live in `deploy/compose.prod.yml`, `deploy/compose.prod.env.example` and
`deploy/k8s/`. Inspect `deploy/k8s/deploy.sh`, `create-secrets.sh` and `verify.sh` before use;
these scripts mutate deployment state. This documentation refresh did not deploy or verify a cluster.

Core owns authorization, Postgres mutations and object capabilities. Collaboration owns editable
CRDT bodies. The unified Go worker uses RabbitMQ and internal APIs; production can isolate roles
using separate deployments. OpenSearch is rebuildable derived state. `deploy/k8s/deploy.sh` still applies `media.yaml`, which references a `${REGISTRY}/media:${TAG}`
image despite the removed Node Media source service. Reconcile that deployment dependency before
assuming the Kubernetes templates implement the completed worker cutover; this audit did not
change deployment behavior.

Keep worker role credentials, Core signing keys, BFF data-protection keys, database credentials and
identity-provider recovery material private. File bytes use private object storage directly through
short-lived capabilities. Database restoration alone cannot restore file-backed documents.

## Backup scope

`deploy/k8s/backup.yaml` currently schedules a logical dump of the Nix database into a PVC.
It does not itself back up object storage, Zitadel, cluster roles or application keys, and a local
PVC is not independent disaster-recovery storage. Preserve all those authoritative resources.
Closure, snapshots, search, links and embeddings are derived and can be rebuilt from durable data.

The repository also contains [a local restic-to-R2 helper](../deploy/backup/README.md) and
`scripts/backup-r2.py`. It includes database dumps, roles, the Versity volume and configured recovery
files. Its presence does not mean a schedule is installed, a remote backup succeeded, or a restore
has been rehearsed. Follow its configuration and consistency limitations before relying on it.

Rehearse recovery into an isolated environment using matching database and identity versions,
original keys and object data. Verify sign-in, permissions, document editing and attachment access
through supported clients. Record actual recovery time and data loss; do not infer success from
archive readability. Pending RabbitMQ work and Postgres outbox recovery also need verification.

## Known implementation limits

Uploads currently use a temporary opaque publication path without inspection or malware scanning;
see the [architecture discrepancy](README.md#open-architecture-discrepancy). Import handlers cover
Markdown, TXT, DOCX, PDF and `.nix`; PDF OCR is unavailable. Production fidelity, failure recovery,
large imports, device behavior and resource limits need their own observed evidence.
