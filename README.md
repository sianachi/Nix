# Nix

Nix is a collaborative document workspace. There is only one kind of item and every
item has a body describing how it renders itself: A simple note, a canvas, a kanban board, canvas later, etc. It can hold
children, can declare a property schema, and can offer views over its
children. There is no separate "folder" type. You can have a parent item that is a spreadsheet and the children are kanban boards.
The intention is for a Wiki like Notion or Obsidian that is fully customizable, allows the kind of workflow that Notion does while
giving you the full flexibility of Obsidian.


## Features

- **One kind of item.** Every item has a body (note, canvas, kanban board, ...), can hold
  children, can declare a property schema, and can offer views over its children — no
  separate "folder" type.
- **Composable hierarchies.** Any item can be the child of any other — a spreadsheet can
  parent a set of kanban boards, a kanban board can parent notes, and so on.
- **Notion-like structure, Obsidian-like flexibility.** Customizable schemas and views give
  you Notion's workflow with the openness of an Obsidian-style wiki.
- **Real-time collaboration.** A dedicated CRDT/WebSocket service keeps documents in sync
  across users.
- **Database-backed permissions.** Roles and authorization live in Postgres with row-level
  security, never in tokens, with a single authorization code path evaluated during query
  time.
- **Write, organise and link.** A rich editor over an append-only CRDT log, an item tree with
  drag-to-reparent and cycle checking, `[[` and `@` references with four resolution states, a
  backlinks panel and full-text search.
- **Three kinds of body, five ways to look at children.** A note, a canvas and a spreadsheet behind
  one dispatch seam; list, board, gallery, calendar and timeline over an item's children, with
  property schemas that cascade from ancestors and are validated on write.
- **A calendar across the workspace**, two panes side by side, and a phone layout below the `sm`
  breakpoint.
- **Leave with your work.** Export a document or a subtree as a lossless `.nix` archive, a PDF or a
  DOCX.

Planned, in priority order — the sequence is the plan:

1. **Templates and the spreadsheet view** — user-authored templates, a template library, templates as
   files, and children as rows and columns
2. **Computed properties** — formulas over an item's own properties, rollups across its children,
   and charts
3. **Running your week** — task semantics, recurrence, reminders that fire with the tab closed,
   smart lists, assignment
4. **Version history** — named versions, compare, restore
5. **Trust** — everything it already does, done provably; the asserted list becomes a proved one
6. **Operability** — backup, a restore drill that is actually run, observability
7. **Import** — `.nix`, Markdown, DOCX and PDF, each honest about what it could not carry
8. **Workspaces and who is in them** — create and switch between workspaces, member and admin roles,
   invitations, revocation that reaches a live session
9. **Reach it without a browser** — a CLI, and an MCP server so tools can drive it

**Every phase ends with a stress test**, and the phase is not finished until it has been run and the
number written down. The first one is a container with 3,000+ children opened in every view it
offers.

Deliberately **not** planned, so nobody waits for them: an extension or plugin platform of any kind;
calendar sync, OAuth and ICS feeds, or anything else that reaches another service; file uploads and
attachments; public sharing and share links; native mobile clients; full ACL precedence with an audit
pipeline; pen input on canvas; and an Obsidian sync. The CLI and MCP server are **not** an extension
platform — they are clients of the API holding no more than the person they act for, which is why
they are planned and a plugin runtime is not. Nix is a self-hosted workspace for a trusted team of
about ten, and `docs/nix-mvps.md` holds the reasoning and, for each exclusion, what it costs.

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

Migrations: `dotnet run --project backend/src/Nix.Migrator` with
`NIX_MIGRATOR_CONNECTION_STRING` set.

**Guard scripts** (gate CI — run before opening a PR):
`scripts/check-layering.sh`, `scripts/check-no-controllers.sh`,
`scripts/check-byte-array-markers.sh` (backend),
`scripts/check-raw-design-values.sh` (frontend).

