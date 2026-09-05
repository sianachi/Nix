# Deploying Nix with Docker Compose

Docker Compose is the default build, release and operations target. Kubernetes manifests are
retained for a future explicit switch; do not run `deploy/k8s/*` during a Compose release.
Start here rather than treating a green container health check as a successful deployment.

## Production baseline

As verified on 2026-09-05, production is `nvidia@192.168.50.26` (Linux ARM64), Compose project
`nix`, public origin `https://nix.urutech.org`. Cloudflare Tunnel reaches Caddy on port 8090;
Caddy routes Core, collaboration and `/nix-worker-jobs/*`. The storage route preserves the
bucket path and signed Host header and reaches `nix-versitygw:7070`. Core and workers sign/use
HTTPS capabilities through the public origin. Never send bearer tokens to object storage.

Versity v1.7.0 owns `nix-versity-data`. MinIO and the old Node Media service are retired.
Do not delete their retained rollback volumes or restart them as part of a normal release.
Postgres, RabbitMQ, OpenSearch, data-protection keys and Caddy also use named persistent volumes.
Never use `docker compose down -v`, `volume prune`, or `--remove-orphans` during deployment.

The last verified deployment uses `/home/nvidia/nix-release-14e0a39d/deploy/compose.host.yml`
and its private `.env`. API/collab/web are `14e0a39d`; all four Go roles are `77ef824a`.
These are historical recovery references, not tags to copy into a new release.
The checked-in manifest now contains Versity, the storage route and the explicit Caddy volume
name previously supplied by that host override. Before the first rollout of this manifest,
compare the effective services, image IDs, volume names and routes against the current host.
Do not apply the old override blindly: it pins old worker images. Keep a private backup of it.

## Prerequisites and configuration

Use Docker Engine with Compose v2 supporting `up --wait`, Git, Node 22+, pnpm, Python 3 and
Poppler's `pdftotext` on the release/verification host. Run `pnpm install --frozen-lockfile`
in the release checkout to build the packages used by `nixctl`.

Copy `deploy/compose.prod.env.example` to a private absolute path, restrict it to mode 0600,
and replace every placeholder. Never commit it or print `docker compose config` with resolved
secrets. Use `config --quiet` for validation. Preserve existing passwords, signing keys,
OIDC identity, storage credentials and data-protection keys on upgrades.

For bundled Versity, set both object-store endpoint and public origin to the application's
HTTPS origin and bucket to `nix-worker-jobs`. The release creates a missing bucket using the
configured keys; it does not migrate objects from another provider. A provider migration requires
separate inventory, copy, size/hash verification, a final write freeze and a retained rollback.
The storage initializer uses AWS CLI on the private network; application transfers still use
public HTTPS so the smoke check exercises the actual edge path.

`NIX_CORE_TOKEN_SIGNING_KEY_FILE` must be an absolute host path. Supply the separate privileged
`NIX_COLLAB_MIGRATOR_CONNECTION_STRING` only for the one-shot document migration service.
It must not replace the restricted collaboration runtime connection. The Core migrator is also
separate from the runtime. The Compose manifest assumes the database and restricted roles already
exist. For a new host, provision those roles, ownership, credentials and OIDC outside this upgrade
procedure; never run development/demo seed scripts against production.

Create an operator-owned `nixctl` profile pointing at the public HTTPS origin, with access to a
dedicated smoke workspace. Authenticate through the supported `nixctl auth login` flow; keep the
PAT in its mode-0600 profile and out of shell history/logs. No production profile is checked in.
The default smoke runner uses `deploy/compose/nixctl.sh`; `NIXCTL_BIN` can select an installed
executable. It must act as the operator through Core, never query application tables directly.

## Build and release

Build on the target host architecture. All five local images come from one committed tree;
`git archive` excludes uncommitted secrets and avoids macOS AppleDouble files in build contexts.

```sh
git fetch origin main
git checkout --detach origin/main
bash deploy/compose/build.sh HEAD
```

The build prints the full SHA. Set `NIX_IMAGE_TAG` and `NIX_WEB_IMAGE_TAG` to that SHA in the
private env file. Normally leave `NIX_WORKER_IMAGE_TAG` unset. For a reviewed worker-only hotfix,
it may select another immutable worker image while other services keep their existing tags;
record the complete image matrix. The build script does not push to a registry or run Kubernetes.

Before rollout, take and verify a restorable Postgres backup and a consistent Versity volume
backup, plus the private configuration and signing keys. Record their locations securely and
check schema rollback compatibility. A string in the following variable records the operator's
verification; the release script does not create or validate backups itself.

```sh
export NIX_DEPLOY_ENV=/absolute/private/production.env
export NIXCTL_PROFILE=production
export NIX_SMOKE_WORKSPACE=<dedicated-workspace-uuid>
export NIX_BACKUP_REFERENCE=<verified-backup-reference>
bash deploy/compose/deploy.sh
```

The script validates configuration and local images, checks verification credentials and confirms the profile URL matches the deployed public origin, brings up
infrastructure and the bucket, stops application writers, runs Core/template/document migrations,
then starts compatible services before the frontend. Expect a maintenance window. It deliberately
does not seed users, delete volumes, force an automatic schema rollback or restart unrelated stacks.
Any failure exits nonzero. Migration failures leave writers stopped for inspection. Once startup
has begun, a later failure may leave some services running; inspect state before resuming.

A release succeeds only after the smoke runner imports a TXT document through the Go worker,
publishes its editable note and retained attachment, exports `.nix`, PDF and DOCX, downloads and
checks checksums through `nixctl`, checks ZIP integrity and verifies imported text in PDF/DOCX.
It soft-deletes its temporary root on success or failure when the ID is known. Calls have a
three-minute bound. If import times out before returning an ID, inspect recent import jobs and
remove any published smoke root; do not assume a timeout implies no mutation.

Run the same checks independently after a worker/storage/edge change:

```sh
NIXCTL_PROFILE=production NIX_SMOKE_WORKSPACE=<uuid> NIX_SMOKE_ORIGIN=https://nix.urutech.org node deploy/compose/smoke.mjs
```

Then check sign-in, deep-link reload, two-browser live editing and persistence after reload,
image picker/drop/paste and opening/downloading an attachment in the browser. The CLI smoke test
does not prove browser CORS/CSP, accessibility, embedded sections, page breaks or image fidelity.
Inspect representative PDF/Word output when changing conversion or editor schemas.

## Troubleshooting and rollback

Always use the same project name, env file and release manifest. Example:

```sh
docker compose -p nix --env-file "$NIX_DEPLOY_ENV" -f deploy/compose.prod.yml ps
docker compose -p nix --env-file "$NIX_DEPLOY_ENV" -f deploy/compose.prod.yml logs --since 10m nix-api nix-import-worker nix-export-worker
```

Treat logs as private: redact credentials, capability queries and document data before sharing.
Use `nixctl` or MCP for product state. A healthy worker only proves process/dependency checks;
a durable job can still retry without a visible UI error. Inspect failure codes and operation IDs.

The 2026-09-05 incident was `export_upload_failed` with a malformed HTTP/1 response containing
HTTP/2 frame bytes. The Go transfer transport inherited `h2` ALPN while disabling its HTTP/2
handler. Commit `77ef824a` aligns ALPN with HTTP/1.1; a TLS-server regression covers both upload
and download. Do not work around transfer failures by disabling TLS verification or widening
capability origins. A generic curl/Python S3 check does not exercise the actual worker transport.

For an application rollback with compatible schemas, select the prior committed checkout and
restore its recorded image matrix/configuration, then use the same release checks. Never rerun an
older document migrator against a newer schema without verifying support. For incompatible schema
changes, stop writers and use the tested database/object backup recovery procedure; image rollback
alone cannot reverse a migration. Retain both releases and backups until functional checks pass.
