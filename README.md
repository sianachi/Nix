# Nix

Nix is a self-hosted life operating system for one person or a group of people who want their notes, tasks, habits,
journal, files, calendar and numbers in one place, on a laptop and on a phone, and who is willing
to set things up to get them. It combines the flexible structure of a wiki with the schemas, views
and workflows of a database workspace, and it keeps everything exportable.

The detailed product direction, feature/reference records and service architecture now live in
[importable native Nix documentation](docs/README.md). The handbook contains 38 service and workflow
pages with Mermaid diagrams, a service catalog and boards grouped by architecture area. The reference
archive adds decision, plan and runbook views. Read source behavior separately from deployment evidence
and ADR status.

## Motivation

- **A life is split across tools.** Notes, tasks, dates, habits, money, files and links usually
  live in separate applications. Nix keeps them in one composable item tree.
- **Rigid hierarchies do not match real work.** Nix separates an item's body from its views, so the
  same children can be seen as a list, board, calendar, timeline, gallery, spreadsheet, chart,
  habit tracker, finance ledger, drive or form.
- **Custom workflows are either too limited or too technical.** Cascading property schemas, formulas,
  rollups, charts, templates, automations and a companion that builds structure on request let one
  person shape their workspace without writing a plugin.
- **Reminders and sync should be quiet and honest.** Due tasks and habit check-ins arrive as push
  notifications with quiet hours; external calendars sync both ways with a visible log.
- **Permission failures are security failures.** Roles and filtering stay in the database, permission
  checks happen during query evaluation, and the web, CLI and MCP use the same authorization path.
- **Search and automation can quietly tell the wrong story.** Search, links, imports, exports and
  data-bearing views expose incomplete or lossy states instead of implying success.
- **Vendor lock-in makes leaving expensive.** Nix exports documents and subtrees as lossless `.nix`
  archives and as PDF, DOCX and Markdown, with format limitations reported before export.
- **Self-hosted software is often difficult to operate safely.** Nix bounds hostile and expensive work,
  keeps derived data rebuildable, ships CI-built images, and provides CLI/MCP access for scripted
  administration and checks.
- **A phone is where life happens.** Nix installs as an app with shortcuts, a share target, offline
  copies of opened notes and a service worker, so the same workspace works on the move.

## Current features

### Notes, structure and editing

- Rich notes with headings, lists, tasks, quotes, code, callouts, tables, images, links, columns,
  collapsible sections, colour, page breaks, embedded live note sections, drag handles and slash
  commands. Optional Vim (Normal, Visual, Visual Line) and Emacs (kill ring, mark) keyboard modes.
- Notes, canvases and spreadsheets as body kinds. Canvases use shared Excalidraw scenes; spreadsheets
  provide A1 addressing, references, ranges, formula functions, dependency tracking and cycle checks.
- Durable file items with immutable versions, replace-in-place, PDF and image previews, file-backed
  editor images, and built-in viewers for EPUB, CSV, Markdown, Mermaid, media and text.
- A composable item tree with nesting, breadcrumbs, drag-to-reparent, cycle checking, a six-entry
  New menu (note, canvas, sheet, upload, structured item, from a template) that asks for a title
  and a location, delete with Undo restore, bookmarks, hidden items, moving items between
  workspaces, two-pane navigation and responsive phone layouts.
- Daily notes with a per-workspace switch, Year/Month folders, a quick capture dialog and a
  "Today" app shortcut.
- CRDT editing over an append-only update log, rebuildable snapshots, WebSocket synchronisation,
  authorization handshakes, presence, live cursors and connection status.
- Version history derived from the collaboration log: revisions, the document as it stood at any
  revision, restore as a new revision, and named versions that retention never deletes.
- Password locks that withhold a subtree's titles, children, views and rollups, and item
  protections (`no_delete`, `no_children`, `managed_by`) for items an integration owns.
- `[[` and `@` references, backlinks, full-text search, a command palette and an accessible graph
  with pan, zoom, fit, neighbourhood highlight, shape by kind, filters, collapsing, a time view and
  saved views.

### Data, views and workflows

- Ancestor-cascading property schemas, validated writes and in-place editing for supported property
  types.
- Formula properties, child rollups and server-backed charts with bounded evaluation and cycle
  detection.
- List, board, calendar, gallery, timeline, spreadsheet, chart, drive, habit tracker, finance,
  Quick Form, Interactive Form and Smart List views, including composed primary and companion
  views; filters on every view, several sort keys and column summaries.
- Guided setup for structured views, with tab-persistent drafts.
- Task semantics for completion, due dates, start dates, priority, estimates and assignees; recurring
  tasks and calendar entries; Today, Next 7 days, Overdue and Assigned to me workflows.
- Habit tracking with check-in and undo, status, streak insights and charts.
- Finance tracking: accounts, loans, budget lines and actuals, transactions, scheduled postings,
  cash flow, a dashboard, a close-month checklist and bank CSV import with preview before commit.
- Reminders as an explicit `reminder` property, due and habit reminders, a notification inbox,
  Web Push through the installed app, quiet hours, a time zone and per-container muting.
- Automations owned by the person who wrote them: schedule, date-arrives and property-changed
  triggers, up to five conditions, and notify, set-property and create-item actions, with a run
  log, a dry run and automatic disable after repeated failures.
- Two-way calendar sync with Google Calendar and Microsoft Outlook from a Calendars settings tab:
  external events in the calendar view, dated Nix items pushed out, last-write-wins with a log,
  and 15-minute drag and resize on entries.
- Model-free suggestions with an off switch: duplicate notices, property suggestions, similar
  items, free-slot and fill-series helpers.
- User-authored, file-backed and managed templates: capture, edit, browse, apply and create from a
  validated template tree, with initialization inputs and relative dates.
- Revocable, opaque Interactive Form links. Sanitized public forms turn responses into ordinary child
  items without exposing the workspace or existing responses.

### Speech and companion

- Meeting recording, transcription and dictation, plus spoken replies in local voices, through an
  optional speech worker role that runs whisper.cpp and Piper on your own host (ADR-0059). The
  browser's own dictation and voices are the fallback when the role is not deployed.
- A ChatGPT companion connected through the Codex device login, with account-scoped character,
  personality, response-length and instruction settings, model selection, per-workspace
  conversations and saved history.
- Explicitly approved companion workspace tools for searching, reading, creating, appending to,
  renaming, moving, trashing, restoring and updating items, and structure tools that create
  structured containers, add views and fields, edit forms and set recurrence. A Design (consult)
  mode validates and builds blueprints and saves them as templates. Every plan is previewed in Nix
  before it runs, reads and writes stay behind Core's permissions, and uncertain results are
  reported for inspection rather than claimed as complete.

### Access, portability and operations

- Core-owned browser BFF authentication with OIDC, PKCE, HttpOnly sessions and short-lived Nix tokens;
  multi-issuer support; workspace-scoped roles, invitations, membership administration, personal
  workspace provisioning and live revocation. Passwords, passkeys and second factors live at the
  identity provider.
- Permission-filtered access backed by Postgres row-level security; roles live in the database, not
  in tokens.
- Personal access tokens with independent `read`, `write` and `admin` scopes and a required expiry
  of 1 to 365 days, for `nixctl`, MCP and scripts.
- Export of documents and subtrees to lossless `.nix`, PDF, DOCX and Markdown, with declared losses.
- Editable Markdown, TXT, DOCX and PDF imports, `.nix` archive import, and a one-time Obsidian
  vault import. PDF OCR is unavailable.
- `nixctl`, a scriptable CLI with JSON output and 28 command groups: auth, workspaces, items,
  notes, properties, schema, views, query, search, structure and blueprints, templates, history,
  recurrence, calendar and calendar sync, finance, habits, notifications, reminders, automations,
  files, export, import, document import, operations, the companion and stress runs.
- An MCP server started through `nixctl mcp`, authenticated as the acting principal and limited to
  that principal's reach, with 93 tools covering workspaces and members, templates, finance,
  habits, document import, files, the companion, structure and blueprints, notifications,
  reminders, item protection, calendar links and automations. Item CRUD and search stay `nixctl`
  commands.
- One Go worker binary with roles for import, export, indexing, signed WebAssembly plugin
  execution, calendar sync, notifications and speech, driven by RabbitMQ; workers use internal
  APIs and object capabilities without database credentials.
- Uploads are inspected by the worker before they are published: size and expiry checks, SHA-256,
  media type from magic bytes, preview and thumbnail generation. Files are not malware-scanned.
- An installable web app with manifest shortcuts (New note, Today, Search), a share target, a
  Markdown file handler, an offline page, offline copies of opened document bodies, last-location
  restore, right-click context menus and a keyboard shortcuts dialog; light and dark themes.
- Docker Compose production manifests with CI-built multi-architecture images, migrations, seed and
  verification jobs, a smoke-tested release script and a restic-to-R2 backup helper. Kubernetes
  manifests are retained. Logical database dumps alone do not restore file-backed documents.


Each planned area has a measurable stress test. A green test suite is not treated as proof of layout,
accessibility, query plans, export fidelity or production operations until those things are observed.


## Stack

- **Backend:** ASP.NET Core 10 (.NET 10), Postgres 16 + RLS + pgvector, EF
  Core for envelope CRUD, hand-written SQL for closure/permissions/search.
- **Frontend:** React 19, TypeScript strict, Tailwind CSS v4, Zod, Zustand,
  axios (only inside `packages/api-client`).
- **Services:** Collaboration is Node 22/TypeScript on Fastify. Go 1.26 workers handle asynchronous
  jobs through RabbitMQ; OpenSearch is a rebuildable derived index. The optional speech role bundles
  whisper.cpp and Piper. Workers never receive DB credentials.
- **Auth:** OIDC (Zitadel first, multi-issuer by design). Roles live in the
  database, never in tokens.

## Repository layout

```
apps/
  web/        React frontend (installable PWA)
  collab/     Collaboration service (CRDT/WebSocket, history, .nix export)
  go-workers/ Unified Go worker: import, export, index, plugin-events, calendar, notify, speech
  cli/        nixctl CLI and MCP server
packages/
  api-client/       Generated HTTP client, contract types
  companion/        Companion workspace-tool executor shared by web and nixctl
  design-tokens/    Colors, fonts, spacing, radii, shadows
  docx-export/      DOCX mapper
  editor-schema/    Shared document/schema types
  export/           .nix archive manifest, writer and reader
  markdown/         Markdown import/export mapping
  pdf-export/       PDF mapper
  sheet/            Spreadsheet formula engine
  structure-spec/   Declarative structure vocabulary and blueprints
  template-catalog/ Managed template presets
  ui/               Component library (Storybook + axe)
  view-render/      Shared view rendering for exports
backend/
  src/
    Nix.Api/            Domain/ -> Abstractions/ -> Persistence/ -> Features/
    Nix.Migrator/       Separate deployable - runs migrations
  tests/
    Nix.Tests/                 Unit, no Docker required
    Nix.Integration.Tests/     Needs Docker + pgvector/pgvector:pg16
  openapi/
    nix-api.json         Generated contract - the seam between backend and
                          frontend; never hand-edit
deploy/
  compose.prod.yml, compose/   Production Compose manifest and release scripts
  docker/                      Image Dockerfiles, including the speech worker
  k8s/                         Retained Kubernetes manifests
  speech/                      Speech model manifest
```

## Production deployment

Docker Compose is the default production target until an explicit decision to return to Kubernetes.
Images are built by CI for every `main` commit and published to `ghcr.io/sianachi/nix`, tagged
with the full commit SHA; a release is `deploy/compose/release.sh <sha>` on the host. Use the
[Compose deployment runbook](deploy/README.md) for configuration, migrations, Versity storage,
the optional speech role, rollback and mandatory import/export verification. Kubernetes tooling
is retained but is not part of the default release workflow.

## Local development

Install Docker, mise and the pinned toolchain once:

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

```sh
export NIX_API_PORT=5015 NIX_API_ORIGIN=http://localhost:5015
export NIX_COLLAB_PORT=8101 NIX_COLLAB_ORIGIN=http://localhost:8101
export NIX_WEB_PORT=5174 NIX_WEB_ORIGIN=http://localhost:5174
export NIX_OBJECT_STORE_PUBLIC_ORIGIN=http://localhost:7070
bash deploy/seed/zitadel-configure.sh
```

Run that setup command again whenever `NIX_WEB_ORIGIN` changes so the OIDC redirect origin stays
in sync. Then run `bash scripts/dev.sh --skip-stack` from the same shell, or start the four host
processes below. The Vite command reads `NIX_WEB_PORT`; do not add an extra `--` before Vite
arguments. Infrastructure ports still need their matching Compose overrides and dependent URLs in
`.env`.

See [local sign-in and setup](docs/dev-signing-in.md) for generated identity configuration.

### Usage

To run the processes separately instead of through `scripts/dev.sh`, start each in its own
terminal after stack-up:

```sh
bash scripts/dev-api.sh                     # :5014 by default, BFF and service configuration
bash scripts/dev-collab.sh                  # :8100 by default
bash scripts/dev-worker.sh                  # :8301, roles import,export,index,plugin-events
pnpm --filter @nix/web dev                  # :5173 by default
```

The dev worker runs the four default roles. The `calendar` and `notify` roles are opt-in through
`NIX_WORKER_ROLES` (calendar needs fake provider origins, notify needs VAPID keys; see the
comments in `scripts/dev-worker.sh`). The `speech` role runs as its own process beside the
default one, `NIX_WORKER_ROLES=speech NIX_WORKER_ADDRESS=:8303 bash scripts/dev-worker.sh`, and
needs `whisper-server`, `piper`, `ffmpeg` and `ffprobe` on PATH plus a ggml model; the web dev
server proxies `/speech` to it.

Open <http://localhost:5173> and sign in as `dev@nix.localhost` with `NixDev-Password1!`
when using the default seed settings. Generated machine-specific configuration is under
`deploy/.zitadel/`; do not copy its IDs into documentation or source.

The dev API defaults to Postgres search (`Nix__Search__OpenSearchEnabled=false`) even though
stack-up starts OpenSearch and the worker indexes events. Enable the API flag explicitly when
exercising OpenSearch. A running web/API pair alone does not run asynchronous jobs.

The companion is available from the workspace UI after it is enabled under Settings. Connect a
ChatGPT account from the companion settings before starting a conversation. The local Go worker
owns the provider session and bounded private companion state; Core mediates all browser requests.
The CLI also exposes the same runtime through `nixctl pet <operation>`, using a short-lived
interactive session token rather than expanding personal-access-token permissions. Pass
`--workspace-tools` only when you want the companion to propose Nix workspace actions; each action
still requires approval in the companion panel.

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
