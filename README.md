# Nix

Nix is a self-hosted collaborative document workspace for a small to medium sized team — a
Microsoft Word alternative for nerds who want their documents to be linkable, programmable and
structured without giving up rich editing or collaboration. It combines the flexible structure of a
wiki with the schemas, views and project workflows of a database workspace.

There is one kind of item. Every item has a body describing how it renders itself, can contain
children, can declare a property schema and can offer views over those children. There is no separate
"folder" type: a spreadsheet can contain kanban boards, a board can contain notes, and any item can
be reorganised without changing what it is.

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

- OIDC authentication with PKCE and multi-issuer support; workspace-scoped roles, invitations,
  membership administration, personal workspace provisioning and live revocation.
- Permission-filtered access backed by Postgres row-level security; roles live in the database, not
  in tokens.
- Export of documents and subtrees to lossless `.nix`, PDF, DOCX and Markdown, with declared losses.
- `nixctl` for machine-readable authentication, item CRUD, notes, properties, views, search, query,
  export, import and stress/read/search/query runs.
- An MCP server started through `nixctl mcp`, authenticated as the acting principal and limited to
  that principal's reach.
- Progressive web app installation, production Docker/Kubernetes manifests, migrations, seed,
  backup jobs, verification jobs and restricted-egress media conversion with no database credentials.

## Planned features

The remaining roadmap is intentionally short and ordered by priority.

1. **Finish running the week.** Add a checklist view, item dependencies and keyboard-complete
   timeline editing; decide the default calendar container; and prove tree, Smart List and timeline
   performance over 10,000 items.
2. **Make the workspace trustworthy and operable.** Complete specialist security, UX,
   structure and performance reviews; run real browser and screen-reader checks; verify exports in
   Word and PDF readers; fix canvas persistence and client-layer defects; add trash, version history,
   bundle and dependency gates; complete backup/restore, observability, security contact and memory
   budgets.
3. **Complete import.** Add `.nix` round-trip import and DOCX/PDF import, resolve wiki links,
   harden hostile-input parsing, make the import path streaming and bounded, and run the full
   10,000-note import plus `.nix` round-trip stress test. Markdown import/export already ships.
4. **Build native clients.** Deliver native desktop and mobile applications with the same documents,
   collaboration, authentication and permission model as the web application, while respecting the
   platform conventions of each device.

Each planned area has a measurable stress test. A green test suite is not treated as proof of layout,
accessibility, query plans, export fidelity or production operations until those things are observed.

## Long-term goals

After the core document workspace and native clients are mature, Nix may grow toward a broader
knowledge and collaboration platform. Long-term goals include:

- An extension and plugin runtime, with a marketplace, third-party authors, reviews and updates.
- Public workspaces, share links and richer public publishing.
- File uploads, attachments and object storage integrated into the document model.
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
- **Services:** Collaboration + Media are Node 22/TypeScript. Media has no
  DB credentials, ever.
- **Auth:** OIDC (Zitadel first, multi-issuer by design). Roles live in the
  database, never in tokens.

## Repository layout

```
apps/
  web/        React frontend
  collab/     Collaboration service (CRDT/WebSocket)
  media/      Media service (no DB access)
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

## Getting started

```
mise install                     # pins Node 22, pnpm 10, .NET 10
cp .env.example .env
docker compose -f deploy/compose.dev.yml up -d
pnpm install --frozen-lockfile
```

The dev stack brings up Postgres+pgvector (5433), Zitadel (8300), versitygw
S3 (7070), ClamAV (3310), a mock LLM (8380), and an Aspire dashboard (18888).
Sign-in credentials and seeded tenant IDs are in `docs/dev-signing-in.md`.

## Running the application

Cold machine, or after wiping Docker volumes — bring up the stack, seed the
database, apply migrations and configure Zitadel in one idempotent step:

```
bash scripts/dev-stack-up.sh
```

Then, each in its own terminal:

```
dotnet run --project backend/src/Nix.Api    # :5014
bash scripts/dev-collab.sh                  # :8100
pnpm --filter @nix/web dev                  # :5173
```

Open `http://localhost:5173` and sign in as `dev@nix.localhost` /
`NixDev-Password1!`.

## Debugging (Rider)

Open the repository root in Rider — that's where `Nix.slnx` and
`pnpm-workspace.yaml` both live, and where the run configurations below are
registered. Six ship in the repo:

- **Nix Full Stack** — runs `Nix Stack Up` once, then starts `Nix.Api`,
  `Collab` and `Web` together. Use this for a cold start or when you just
  want everything running.
- **Nix.Api**, **Collab**, **Web** — one service each, no stack-up step, for
  a fast restart of just the piece you're working on.
- **Nix Stack Up**, **Nix Migrate DB** — the setup scripts on their own.

`Nix.Api`'s secrets (`ConnectionStrings:Nix`, `Nix:InternalSecret`) come from
.NET user-secrets rather than an exported environment variable, which is what
lets Rider's own debugger run and breakpoint it directly. On a fresh checkout
they won't be set yet:

```
dotnet user-secrets set "ConnectionStrings:Nix" "Host=localhost;Port=5433;Database=nix;Username=nix_app;Password=nix-dev-app" --project backend/src/Nix.Api
dotnet user-secrets set "Nix:InternalSecret" "nix-dev-internal" --project backend/src/Nix.Api
```

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

**Guard scripts** (gate CI — run before opening a PR):
`scripts/check-layering.sh`, `scripts/check-no-controllers.sh`,
`scripts/check-byte-array-markers.sh` (backend),
`scripts/check-raw-design-values.sh` (frontend).
