# Nix

Nix is a self-hosted life workspace for notes, tasks, habits, journals, files, calendars and numbers,
usable on a laptop or phone. There is one structural item kind: every item can have its own body,
contain children, declare property fields and offer views over those children. Core owns permissions;
the web, CLI, MCP, collaboration service and workers use that authority.

The detailed product direction, feature/reference records and service architecture now live in
[importable native Nix documentation](docs/README.md). The handbook contains 38 service and workflow
pages with Mermaid diagrams, a service catalog and boards grouped by architecture area. The reference
archive adds decision, plan and runbook views. Read source behavior separately from deployment evidence
and ADR status.

The current design follows `main` at `e037eb02` (9 October 2026): Core and collaboration use
PostgreSQL, RabbitMQ dispatches work to five Go roles, and files use object-store capabilities.
Search runs in PostgreSQL. Native, Markdown, DOCX and PDF exports remain in the Go worker;
speech, OpenSearch indexing and the bundled logging stack are retired. The native reference
keeps their earlier design records as history.

The companion's per-conversation "Apply without asking" switch runs clean changes without a click;
moving to trash, moving items, saving templates and anything carrying an external link still ask.
The original product overview, including its full companion wording, is preserved in the native
reference archive.

## Read or import the documentation

- [Nix architecture handbook](docs/nix/nix-architecture.nix): services, transports, storage,
  authorization, jobs, clients, deployment and recovery.
- [Nix repository reference](docs/nix/nix-reference.nix): product direction, decisions, plans and
  historical records, with exact original-source child notes.
- [Documentation catalog](docs/nix/catalog.json): source IDs, hashes, migration dispositions and proof.

Import through the Nix document importer, or with `nixctl` after signing in:

```sh
nixctl import docs/nix/nix-architecture.nix --workspace <workspace-id>
nixctl import docs/nix/nix-reference.nix --workspace <workspace-id>
```

Browse offline with the Go TUI, using the same pinned toolchain as the workers:

```sh
go -C apps/go-workers run ./cmd/nix-docs
go -C apps/go-workers run ./cmd/nix-docs list
go -C apps/go-workers run ./cmd/nix-docs read system-map
go -C apps/go-workers run ./cmd/nix-docs read docs/plans/life-os-direction.md
go -C apps/go-workers run ./cmd/nix-docs check
```

Original `.md` paths in code comments are document identifiers in the native catalog. Recover their
exact UTF-8 text with `go -C apps/go-workers run ./cmd/nix-docs source <original-path>`.

## Develop and contribute

Read [AGENTS.md](AGENTS.md) first and follow its focused contributor guides. Install Docker and mise,
then use the pinned toolchain and reproducible development launcher:

```sh
mise install
pnpm install --frozen-lockfile
pnpm dev
```

Open <http://localhost:5173>. `pnpm dev` provisions development infrastructure, rebuilds packages and
runs Core, collaboration, the default Go roles and web. Use `bash scripts/dev.sh --help` for selected
processes and `--skip-stack`. Generated identity settings and private credentials stay outside source.
The offline reader can show `docs/dev-signing-in.md` for port overrides and sign-in troubleshooting.

Before proposing a change, run `./scripts/changed-path-checks.sh --working-tree`, then
`./scripts/validate-changed.sh --working-tree` and any required live proof. Generated OpenAPI/client
code is a contract seam; do not edit it by hand. Query product state through `nixctl` or MCP.

Production uses CI-published SHA-tagged images and Docker Compose. The [offline deployment runbook](deploy/README.md)
and [production backup/restore guide](deploy/backup/production.md) stay in Markdown so operators can
recover while Nix is unavailable. This documentation change does not deploy a release.
