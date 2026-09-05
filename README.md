# Nix

Nix is a self-hosted collaborative document workspace for a small to medium sized team — a
Microsoft Word alternative for nerds who want their documents to be linkable, programmable and
structured without giving up rich editing or collaboration. It combines the flexible structure of a
wiki with the schemas, views and project workflows of a database workspace.

There is one kind of item. Every item has a body describing how it renders itself, can contain
children, can declare a property schema and can offer views over those children. There is no separate
"folder" type: a spreadsheet can contain kanban boards, a board can contain notes, and any item can
be reorganised without changing what it is.

This overview describes committed implementation as of 5 September 2026. Runtime, export-fidelity
and recovery verification remain separate from implementation status. See [documentation](docs/README.md).

## Problems Nix is solving

- **Documents and project work are split across tools.** Notes, tasks, dates, structured records and
  links usually live in separate applications. Nix keeps them in one composable item tree.
- **Rigid hierarchies do not match real work.** Nix separates an item's body from its views, so the
  same children can be seen as a list, board, calendar, gallery, timeline, spreadsheet or form.
- **Custom workflows are either too limited or too technical.** Cascading property schemas, formulas,
  rollups, charts, templates and guided view setup let a team shape its workspace without a plugin or
  waiting for a developer.
- **Collaboration creates lost edits and unclear ownership.** CRDT-backed documents, an append-only
  update log, live presence and database-enforced authorization let people work together safely.
- **Permission failures are security failures.** Roles and filtering stay in the database, permission
  checks happen during query evaluation, and the web, CLI and MCP use the same authorization path.
- **Search and automation can quietly tell the wrong story.** Search, links, imports, exports and
  data-bearing views expose incomplete or lossy states instead of implying success.
- **Vendor lock-in makes leaving expensive.** Nix exports documents and subtrees as lossless `.nix`
  archives and as PDF, DOCX and Markdown, with format limitations reported before export.
- **Self-hosted software is often difficult to operate safely.** Nix bounds hostile and expensive work,
  keeps derived data rebuildable, and provides CLI/MCP access for scripted administration and checks.
- **A browser is not always the best place to work.** Nix plans native desktop and mobile clients so
  the same document workspace can feel at home in a focused desktop editor and on the move.

## Current features

### Documents, structure and collaboration

- Durable file uploads and attachments, PDF and supported-image previews, file-backed editor images,
  embedded live note sections and explicit page breaks.
- Rich notes with headings, lists, tasks, quotes, code, callouts, tables, images, links, columns,
  collapsible sections, colour, drag handles and slash commands.
- A composable item tree with nesting, breadcrumbs, drag-to-reparent, cycle checking, create-in-place,
  delete with Undo restore, two-pane navigation and responsive phone layouts.
- Notes, canvases and spreadsheets as body kinds. Canvases use shared Excalidraw scenes; spreadsheets
  provide A1 addressing, references, ranges, formula functions, dependency tracking and cycle checks.
- CRDT editing over an append-only update log, rebuildable snapshots, WebSocket synchronisation,
  authorization handshakes, presence, live cursors and connection status.
- `[[` and `@` references, backlinks, full-text search, a command palette and an accessible graph
  view with both a visual graph and a text tree.

### Data, views and workflows

- Ancestor-cascading property schemas, validated writes and in-place editing for supported property
  types.
- Formula properties, child rollups and server-backed charts with bounded evaluation and cycle
  detection.
- List, board, calendar, gallery, timeline, spreadsheet, Quick Form, Interactive Form and Smart List
  views, including composed primary and companion views.
- Guided setup for structured views, with tab-persistent drafts.
- Task semantics for completion, due dates, start dates, priority, estimates and assignees; recurring
  tasks and calendar entries; Today, Next 7 days, Overdue and Assigned to me workflows.
- Workspace-wide calendar aggregation, explicit calendar-entry destinations and keyboard navigation
  in list cells.
- User-authored, file-backed and managed templates: capture, edit, browse, apply and create from a
  validated template tree.
- Revocable, opaque Interactive Form links. Sanitized public forms turn responses into ordinary child
  items without exposing the workspace or existing responses.

### Access, portability and operations

- Core-owned browser BFF authentication with OIDC, PKCE, HttpOnly sessions and short-lived Nix tokens;
  multi-issuer support; workspace-scoped roles, invitations,
  membership administration, personal workspace provisioning and live revocation.
- Permission-filtered access backed by Postgres row-level security; roles live in the database, not
  in tokens.
- Export of documents and subtrees to lossless `.nix`, PDF, DOCX and Markdown, with declared losses.
- `nixctl` for machine-readable authentication, item CRUD, notes, properties, views, search, query,
  export, import and stress/read/search/query runs.
- An MCP server started through `nixctl mcp`, authenticated as the acting principal and limited to
  that principal's reach.
- RabbitMQ-backed import, export, indexing and signed WebAssembly plugin execution in a unified Go
  worker; workers use internal APIs and object capabilities without database credentials.
- Editable Markdown, TXT, DOCX and PDF imports, plus `.nix` archive import. PDF OCR is unavailable.
- Docker/Kubernetes manifests, migrations, seed and verification jobs. The Kubernetes backup job
  dumps the Nix database only; full recovery also requires object storage, identity data and keys.

## Planned features

The remaining roadmap is intentionally short and ordered by priority.

1. **Finish running the week.** Add a checklist view, item dependencies and keyboard-complete
   timeline editing; decide the default calendar container; and prove tree, Smart List and timeline
   performance over 10,000 items.
2. **Make the workspace trustworthy and operable.** Complete specialist security, UX,
   structure and performance reviews; run real browser and screen-reader checks; verify exports in
   Word and PDF readers; verify the revised canvas persistence and client behavior; complete trash, version history,
   bundle and dependency gates; complete backup/restore, observability, security contact and memory
   budgets.
3. **Prove import and portability.** Verify `.nix` round trips and DOCX/PDF fidelity, resolve remaining
   wiki-link gaps, audit hostile-input and streaming bounds, and run the full 10,000-note import
   stress test. Import handlers exist; their presence does not establish end-to-end fidelity or scale.

Each planned area has a measurable stress test. A green test suite is not treated as proof of layout,
accessibility, query plans, export fidelity or production operations until those things are observed.

## Long-term goals

After the core document workspace and native clients are mature, Nix may grow toward a broader
knowledge and collaboration platform. Long-term goals include:

- A broader extension ecosystem, marketplace, third-party authors, reviews and updates beyond the
  implemented signed-component worker runtime.
- Public workspaces, share links and richer public publishing.
- External calendar integrations, OAuth connections and ICS feeds.
- More expressive access control, including full ACL precedence, deny rules, inheritance breaks and
  an audit pipeline.
- Collaboration at 100+ concurrent editors in one document.
- Pen input on canvas, including pressure, tilt and palm rejection.
- Obsidian synchronisation.
- Habit tracking, pomodoro timers, email as a first-class object, real-time voice/video and a theme
  marketplace.

These are deliberately longer-term ambitions rather than promises about the current release. The CLI
and MCP are API clients, not an extension platform, and native desktop and mobile applications are
already part of the nearer-term plan above.

## Stack

- **Backend:** ASP.NET Core 10 (.NET 10), Postgres 16 + RLS + pgvector, EF
  Core for envelope CRUD, hand-written SQL for closure/permissions/search.
- **Frontend:** React 19, TypeScript strict, Tailwind CSS v4, Zod, Zustand,
  axios (only inside `packages/api-client`).
- **Services:** Collaboration is Node 22/TypeScript. Go 1.26 workers handle asynchronous jobs
  through RabbitMQ; OpenSearch is a rebuildable derived index. Workers never receive DB credentials.
- **Auth:** OIDC (Zitadel first, multi-issuer by design). Roles live in the
  database, never in tokens.

## Repository layout

```
apps/
  web/        React frontend
  collab/     Collaboration service (CRDT/WebSocket)
  go-workers/ Unified Go worker (role-configurable, no DB access)
  cli/        nixctl CLI and MCP server
packages/
  api-client/     Generated HTTP client, contract types
  design-tokens/  Colors, fonts, spacing, radii, shadows
  editor-schema/  Shared document/schema types
  export/
  sheet/
  ui/             Component library (Storybook + axe)
backend/
  src/
    Nix.Api/            Domain/ -> Abstractions/ -> Persistence/ -> Features/
    Nix.Application/
    Nix.Core/
    Nix.Infrastructure/
    Nix.Migrator/        Separate deployable — runs migrations
  tests/
    Nix.Tests/                 Unit, no Docker required
    Nix.Integration.Tests/     Needs Docker + pgvector/pgvector:pg16
  openapi/
    nix-api.json         Generated contract — the seam between backend and
                          frontend; never hand-edit
```

## Production deployment

Docker Compose is the default production target until an explicit decision to return to Kubernetes.
Use the [Compose deployment runbook](deploy/README.md) for immutable builds, migrations, Versity
storage, rollback and mandatory import/export verification. Kubernetes tooling is retained but is
not part of the default release workflow.

## Getting started

Install Docker, mise and the pinned toolchain, then bootstrap packages and infrastructure:

```sh
mise install                     # Node 22, pnpm 10, .NET 10, Go 1.26
pnpm install --frozen-lockfile
bash scripts/dev-stack-up.sh
```

Stack-up starts the `core` and `search` Compose profiles, prepares the private object bucket,
seeds the database, applies migrations and configures Zitadel. It is safe to rerun. A root `.env`
is optional; the scripts do not automatically source it. For direct Compose overrides use
`docker compose --env-file .env -f deploy/compose.dev.yml --profile core --profile search up -d`.

Infrastructure ports: Postgres 5433, Versity S3 7070, RabbitMQ 5673 (management 15673),
Zitadel 8300, OpenSearch 9201 and Aspire 18888. The mock LLM on 8380 requires the optional
`ai` profile. The current Compose file has no ClamAV service.

See [local sign-in and setup](docs/dev-signing-in.md) for generated identity configuration.

## Running the application

Start each process in its own terminal after stack-up:

```sh
bash scripts/dev-api.sh                     # :5014, BFF and service configuration
bash scripts/dev-collab.sh                  # :8100
bash scripts/dev-worker.sh                  # :8301, import/export/index/plugin-events
pnpm --filter @nix/web dev                  # :5173
```

Open <http://localhost:5173> and sign in as `dev@nix.localhost` with `NixDev-Password1!`
when using the default seed settings. Generated machine-specific configuration is under
`deploy/.zitadel/`; do not copy its IDs into documentation or source.

The dev API defaults to Postgres search (`Nix__Search__OpenSearchEnabled=false`) even though
stack-up starts OpenSearch and the worker indexes events. Enable the API flag explicitly when
exercising OpenSearch. A running web/API pair alone does not run asynchronous jobs.

## Debugging (Rider)

Open the repository root containing `Nix.slnx` and `pnpm-workspace.yaml`. Local run
configurations may be present under `.idea/`, but that directory is ignored and configurations
can contain machine-specific identity settings. The scripts above are the reproducible setup.
For breakpoints, attach Rider to the API process started by `scripts/dev-api.sh`, or configure
an equivalent .NET launch using the environment set by that script. Database and internal-secret
settings alone are insufficient: BFF, access-token signing, object storage and RabbitMQ settings
are also required. Never commit generated identity IDs or signing keys.

## Common commands

Run frontend commands from the repository root; run backend commands from
the repository root too, since `Nix.slnx` lives there.

**Frontend**

```
pnpm lint          # ESLint + Prettier check
pnpm typecheck
pnpm test
pnpm build
```

One package: `pnpm --filter @nix/web test` (also `@nix/ui`, `@nix/api-client`,
`@nix/design-tokens`, `@nix/editor-schema`, `@nix/collab`).

One file: `pnpm --filter @nix/web exec vitest run src/path/foo.test.ts`
(add `-t "behavior sentence"` to narrow further).

Dev server: `pnpm --filter @nix/web dev` (5173; proxies the API on 5014 and
collab on 8100).

Storybook: `pnpm --filter @nix/ui storybook` (6006);
`pnpm --filter @nix/ui test-storybook` runs the axe pass.

**Backend**

```
dotnet format Nix.slnx --verify-no-changes
dotnet build Nix.slnx --configuration Release
dotnet test backend/tests/Nix.Tests/Nix.Tests.csproj              # unit, no Docker
dotnet test backend/tests/Nix.Integration.Tests/Nix.Integration.Tests.csproj  # needs Docker
```

For an API contract change, regenerate OpenAPI explicitly, then regenerate the
typed client:

```
dotnet build backend/src/Nix.Api/Nix.Api.csproj -p:NixGenerateOpenApiContract=true
pnpm --filter @nix/api-client generate
```

Migrations: `dotnet run --project backend/src/Nix.Migrator` with
`NIX_MIGRATOR_CONNECTION_STRING` set.

**Go workers** (from `apps/go-workers`)

```sh
go vet ./...
go test ./...
go test -race ./...
go build ./cmd/nix-worker
```

**Validation selection**

Run `./scripts/changed-path-checks.sh --working-tree` first, or pass explicit changed paths.
Follow its selected checks and [the validation guide](docs/agent-guides/workflow-and-validation.md).
Frontend guards include raw design values, layering, text primitives and spacing roles; each
fixture self-test runs before its guard. Broad root commands above are useful for cross-cutting work.
Query or stress a live Nix instance through `nixctl` or its MCP server.

**Operations**

See [operations and recovery](docs/operations.md) for deployment entry points and backup limits.
