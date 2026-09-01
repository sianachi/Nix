# Repository Guidelines

## Nix Standards for All Contributors

Nix is a premium collaborative document workspace. Premium means: efficient, correct, consistent. `README.md` describes the current product direction and `docs/adr/` records binding architectural decisions. The repository and its tests are the source of truth for shipped behavior. Surprising decisions require an ADR in `docs/adr/` — if you're about to make one, stop and surface it first.

## Stack

- **Backend:** ASP.NET Core 10 (.NET 10), Postgres 16 + RLS + pgvector, EF Core for envelope CRUD, hand-written SQL for closure/permissions/search.
- **Frontend:** React 19, TypeScript strict, Tailwind CSS v4, Zod, Zustand, axios (only inside `packages/api-client`).
- **Services:** Collaboration is Node 22/TypeScript. One Go 1.26 program runs configurable import, export, indexing and plugin-event roles. Go workers have no DB credentials, ever.
- **Search:** Postgres remains the authoritative store and migration fallback; OpenSearch is a rebuildable derived index populated by the Go indexer.
- **Desktop:** Electron 38 is a hardened shell around the hosted web application; it does not embed another backend or fork product behavior.
- **Auth:** Core mediates browser OIDC (Zitadel first, multi-issuer by design) through BFF endpoints and an HttpOnly session. Roles live in the database, never in tokens.

## Recently landed architecture

- **Browser authentication is a Core-owned BFF flow.** The web app no longer runs an OIDC client or stores provider tokens. `/auth/login`, `/auth/callback`, `/auth/session`, `/auth/token` and logout are the browser boundary. Core exchanges provider tokens, performs bounded UserInfo lookup, creates the browser session and issues short-lived Nix access tokens to the web client. Local development uses `scripts/dev-stack-up.sh` followed by `scripts/dev-api.sh`; Rider must carry the same settings as `scripts/dev-api.sh`.
- **Human first sign-in is opt-in JIT provisioning.** Provider registrations decide whether JIT is allowed and carry the bounded UserInfo endpoint. External identity is `(tenant_id, issuer, subject)`. Successful first sign-in creates the human, personal workspace, protected owner membership, Daily Notes root and shipped presets transactionally. UserInfo must be HTTPS and same-origin with the validated issuer; development may use plain HTTP only when both are the same loopback origin. See ADR-0045.
- **Application navigation is workspace scoped.** Authenticated routes use `/w/:workspaceId/*`. Workspace reach and capabilities are server-decided; switching workspace clears item and pane request state. Personal ownership and shared-workspace last-owner rules are persistence invariants, not client policy.
- **Go is a production service tier.** `apps/go-workers/cmd/nix-worker` is one executable configured with any combination of import, export, index and plugin-event roles. Production may deploy those roles separately for isolation; local development runs them together on port 8301. RabbitMQ carries durable commands, workspace events, worker results and expiring capability advertisements, while Postgres remains the authoritative job, lease and outbox store. Workers transfer bytes through capability URLs, report retry-safe results and never mutate Postgres directly. See ADR-0046 and ADR-0048.
- **Import/export orchestration crosses existing service boundaries without Media.** Nix.Api owns job identity, tenant context, authorization, object capabilities, staging, leases and durable status. The Go import role validates files and parses documents; the export role consumes Collaboration's authorized bundle stream and advertises its live formats to Core. Collaboration remains the editable-body and lossless `.nix` boundary. Browser and worker bytes move directly to private object storage.
- **OpenSearch contains derived search documents only.** The indexer consumes leased outbox events, applies idempotent upserts/deletes and stores tenant plus authorization filter fields. Postgres remains authoritative and Nix.Api remains the final authorization authority. An index must be disposable and rebuildable.
- **Canvas is a native Nix body renderer.** It is a bounded, versioned Yjs-backed scene implemented in `apps/web/src/editor/nix-canvas*`, not an Excalidraw wrapper. It supports native shapes, freehand paths, item-backed cards, reusable personal library items, import/export and viewport culling. Canvas remains a body kind; it never changes the one-kind-of-item structural rule.
- **Large frontend compositions are decomposed by responsibility.** `shell/` separates effects, header, sidebar and toast composition; template studio separates model, facts, notices, shell and steps. Keep orchestration thin and move cohesive behavior into files named for what they know.
- **The desktop application is a secure hosted-web shell.** `apps/desktop` enables context isolation and sandboxing, disables Node integration, denies unapproved navigation and sends safe external links to the OS browser. Do not add privileged preload APIs without an explicit reviewed need.

## Commands

`mise install` pins the toolchain (Node 22, pnpm 10, .NET 10). Run frontend commands from the repository root.

**Frontend** — `pnpm install --frozen-lockfile`, then `pnpm lint` (ESLint + Prettier check), `pnpm typecheck`, `pnpm test`, `pnpm build`. Each recurses the workspace with `--if-present`.

- One package: `pnpm --filter @nix/web test` (also `@nix/ui`, `@nix/api-client`, `@nix/design-tokens`, `@nix/editor-schema`, `@nix/collab`)
- One file or one test: `pnpm --filter @nix/web exec vitest run src/path/foo.test.ts`, add `-t "behavior sentence"` to narrow further
- Dev server: `pnpm --filter @nix/web dev` (5173; proxies the API on 5014 and collab on 8100)
- Storybook: `pnpm --filter @nix/ui storybook` (6006); `pnpm --filter @nix/ui test-storybook` runs the axe pass

**Backend** — from the repository root, since `Nix.slnx` sits there. It is the only project or solution file at the root, so a bare `dotnet build` / `dotnet test` resolves to it; the commands below still name it explicitly, because that is what CI runs and it stays correct from any directory:

- `dotnet format Nix.slnx --verify-no-changes` then `dotnet build Nix.slnx --configuration Release` (analyzers, warnings-as-errors)
- Unit: `dotnet test backend/tests/Nix.Tests/Nix.Tests.csproj` — must stay free of Testcontainers so it never needs a Docker daemon
- Integration: `dotnet test backend/tests/Nix.Integration.Tests/Nix.Integration.Tests.csproj` — needs Docker and `pgvector/pgvector:pg16`
- One test: append `--filter "FullyQualifiedName~SomeTest"`
- Migrations: `dotnet run --project backend/src/Nix.Migrator` with `NIX_MIGRATOR_CONNECTION_STRING` set

**Go workers** — from `apps/go-workers`:

- Format: `gofmt -w <changed .go files>` and verify with `test -z "$(gofmt -l .)"`
- Static checks: `go vet ./...`
- Unit/contract tests: `go test ./...`
- Race tests: `go test -race ./...`
- Build the unified executable: `go build ./cmd/nix-worker`

**Desktop** — from the repository root:

- Development: `pnpm desktop:dev`
- Tests: `pnpm --filter @nix/desktop test`
- Unpacked build: `pnpm desktop:build`

**Guard scripts** (all gate CI — run them before claiming a goal is green):

- `ci-backend.yml` runs `check-layering.sh`, `check-no-controllers.sh`, `check-byte-array-markers.sh`, and `check-root-is-unambiguous.sh` (which guards the repository root rather than the backend, but has to run somewhere).
- `ci-frontend.yml` runs `check-raw-design-values.sh`; `check-spacing-roles.sh` (added 2026-08-06 — catches a real, valid spacing token used where a structural role's convention calls for a different one, which `check-raw-design-values.sh` cannot see by construction); `check-text-primitive.sh` (a text element wearing a valid step of the type scale instead of asking `<Text>` for a variant); and `check-frontend-layering.sh` (added 2026-08-11 — the frontend's dependency direction, see Architecture rules).

Every frontend guard ships a `.test.sh` self-test that runs against its own `mktemp` fixture corpus, never the repository tree, so it stays a test of the matcher rather than a change detector for other people's work. `ci-frontend.yml` runs the self-test **first**, then the guard: a broken matcher and a dirty tree both turn the job red, and only that order tells them apart. A new guard follows the same shape, and both filenames go in the workflow's `push:` and `pull_request:` path triggers.

**Dev stack** — run `scripts/dev-stack-up.sh`. It starts the `core` and `search` Compose profiles, applies migrations, configures Zitadel and prepares the private object bucket. Then start host processes with `scripts/dev-api.sh`, `pnpm --filter @nix/web dev`, `scripts/dev-collab.sh` and `scripts/dev-worker.sh`. Postgres+pgvector is 5433, RabbitMQ is 5673, Zitadel 8300, Versity S3 7070, Core 5014, web 5173, Collaboration 8100, the unified Go worker 8301, OpenSearch 9201 and Aspire 18888. Generated local OIDC state lives under `deploy/.zitadel/`; never hand-copy its machine-specific IDs into source.

**Worktrees** — create focused branches using the current issue or feature name. Do not mint identifiers from retired goal-label schemes.

## Known friction for agents

Measured problems, not folklore — each reproduced in this repository. Until fixed, work around them
as follows.

- **~~A fresh `pnpm install` does not build generated workspace packages.~~ Fixed.** The
  root `prepare` script builds the editor schema, API client, sheet, export, design-token, PDF, DOCX,
  view-render and Markdown packages, so `pnpm install` leaves a clean worktree able to run `lint`,
  `typecheck` and `test` with no manual step. `pnpm run bootstrap` does the same build by hand if a
  `dist/` is ever wiped without reinstalling. Cost: about 3.5s on a warm install. If you install with
  `--ignore-scripts`, you own the build yourself.
- ~~**`dotnet build`/`dotnet test` need `Nix.slnx` named explicitly from the repo root.**~~ Fixed:
  the browse-only `Nix.Frontend.csproj` moved into `Nix.Frontend/`, leaving `Nix.slnx` as the only
  candidate at the root, so an unqualified `dotnet build` resolves to it. Note that a bare
  `dotnet test` now runs the whole solution, which includes `Nix.Integration.Tests` and therefore
  needs Docker — name `backend/tests/Nix.Tests/Nix.Tests.csproj` when you want the daemon-free suite.
- **`pnpm --filter @nix/ui test-storybook` can hang indefinitely in a sandboxed/headless
  environment** rather than fail. It launches headless Chrome and stalls before collecting a single
  test, reproducibly, even against untouched story files. If it stalls past a couple of minutes,
  stop and report the axe pass as unverified rather than retrying or claiming it passed.
- **Vitest's default 5s test timeout is tight for the calendar arithmetic tests under load.** A
  calendar test failing only when several suites run in parallel is very likely this, not a
  regression — rerun it in isolation before treating it as real.
- **`packages/api-client`'s generated client is not regenerated in CI, only verified.** After any
  change to `backend/openapi/nix-api.json`, run `pnpm --filter @nix/api-client generate` and commit
  the result. `ci-frontend.yml`'s `frontend static` job fails if you don't, but it will not do it for
  you.
- **Old local planning documents are gone.** Do not cite `docs/nix-mvps.md`,
  `docs/nix-mvp-plan.md`, `docs/nix-goal-plan.md`, `docs/nix-engineering-plan.md` or
  `docs/nix-development-document.md`; they are not present in this repository. Use the current
  README, ADRs, GitHub issues and observed code/tests. Do not revive retired `G<n>`, `U<n>`, `C<n>`
  or `K<n>` labels.

## The contract seam

`backend/openapi/nix-api.json` is the boundary between the two lanes. The backend build regenerates it; CI fails on `git diff --exit-code -- backend/openapi`, so a contract change must be rebuilt locally and committed with the code that caused it. `packages/api-client` generates its types from that file via `pnpm --filter @nix/api-client generate`, and frontend CI re-runs on any change to it. Never hand-edit either the JSON or `src/generated/`.

CI is two path-filtered workflows (`ci-backend.yml`, `ci-frontend.yml`) so the lanes don't contend; both run on changes to the shared guard scripts and to `backend/openapi`.

## Architecture rules (non-negotiable)

- Dependency direction is carried by **folders inside `Nix.Api`**, not project references (ADR-0015): `Domain/` (model, typed IDs, `Result`, validators) → `Abstractions/` (ports: `IItemTree`, `IPermissionResolver`, `ISchemaResolver`, ...) → `Persistence/` (EF Core, Npgsql, hand-written SQL, RLS) → `Features/` (vertical slices: endpoint, command/query, handler, contract). `Domain/` carries no infrastructure — no database, no web framework, nothing from a layer above. Its one third-party reference is NodaTime, which is value types with no I/O (ADR-0012); anything else needs the same argument made in writing. `scripts/check-layering.sh` enforces this in CI, replacing the assembly-reference tests the single-project collapse made unexpressible. `Nix.Migrator` stays a separate project — different executable, different deployment.
- **The frontend carries its direction in folders too.** Across workspaces the rule is `apps/* → packages/*`, never sideways or upward — that one is **convention, enforced by review only**: `scripts/check-frontend-layering.sh` (added 2026-08-11) scopes itself to `apps/web/src`, so a `packages/ui` file importing `apps/web` passes it silently. Inside `apps/web/src`, four tiers, and those the guard does check:

  | Tier | Folders | May import |
  |---|---|---|
  | leaf | `lib/`, `a11y/` | third-party and their own folder, nothing else |
  | leaf | `layout/` | the above, plus `lib/` |
  | feature | everything else under `src/` | the leaves, siblings, and `shell/` **type-only** |
  | shell | `shell/` | anything; imported for a value only by `app.tsx` |

  The leaf rules compose on purpose: `layout/` may only reach `lib/`, and `lib/` may reach nothing, so there is no path out of the leaf set at all. This replaced `app/`, which was a leaf and a root at once — half the application imported its vocabulary while its composition imported half the application — and had produced a real cycle (`app-shell → items/workspace-sidebar → app/announcer`). The split is meant to make that class of cycle unexpressible rather than merely detected, which is why the guard carries **no exemption marker for any rule**: a direction rule with an escape hatch is a suggestion.

  **Two known matcher defects, until they are fixed (found 2026-08-14, reproduced against a fixture tree).** R4's type-only allowance is a de-facto escape hatch: `import { type ShellContext, AppShell } from '../shell/app-shell'` **passes**, because `{ type ` matches the exemption and the value import rides along — so a feature can take a runtime value from `shell/` today. And R1's allowlist is not depth-generalised, so `layout/<sub>/x.ts` importing `'../../lib/…'` **fails** though the table permits it. Read the tiers above as the rule and the guard as an incomplete check of it; do not take a green guard as proof of direction on either of those two paths.

  `layout/` is the arrangement (regions, viewport thresholds, the sidebar's width and its two structural components); `shell/` is the composition (app-shell, nav-rail, profile-menu, require-session, and the `ShellContext` it hands down). A file that knows what data a region shows belongs in `shell/` or a feature folder, never in `layout/`.
- Use cases are CQRS messages: `ICommand<TValue>`/`IQuery<TResult>` with `ICommandHandler<,>`/`IQueryHandler<,>`, dispatched by the hand-written `NixDispatcher`. No MediatR, no assembly scanning — handlers are registered explicitly, one line each, and `CompositionRootTests` resolves every registration so a missing one fails a test rather than the first request that needs it.
- Permission filtering happens **during** query evaluation, never after. One authorization code path (Core). The client never computes permissions.
- **Authentication is enforced by route family.** `NixUnitOfWorkMiddleware` covers `/api/v1` except health and establishes tenant/principal context for RLS. `/auth` is the explicit browser BFF boundary: login and callback are public protocol endpoints, while session/token/logout enforce the browser-session and origin rules in that feature. `/internal` is a separate service boundary authenticated with the internal service secret and, where acting-user authority is required, a forwarded bearer token plus correlation/job identifiers. Do not move an endpoint between these families casually; a route outside them is open unless its feature explicitly proves otherwise. There is no endpoint-level `RequireAuthorization` safety net.
- RLS session context uses `SET LOCAL`, never `SET` (pooled-connection leak).
- Derived data (closure, snapshots, search, links, embeddings) must stay rebuildable from durable data.
- **There is one kind of item.** Every item has a body, can hold children, can declare a property schema, and can offer views over its children. `item.type` says how an item's own *body* is drawn (note today, canvas later) and must never gate structure — a `type === '...'` check that decides what an item may contain is the bug ADR-0009 removed. There is no "folder".
- Two axes, kept apart: an item's **body** (`item.type`, open string) renders its own content; its **views** (`item.views`, closed set, server-validated) render its children. A canvas is a body kind, not a view.
- File bytes never pass through Core — presigned URLs only.
- New interfaces need: two real implementations, a test fake for I/O, or a documented swap plan. Otherwise inject the concrete type.

## Go worker rules

- Keep `cmd/*/main.go` as wiring only. Shared lifecycle belongs in `internal/runtime`; bounded transport and domain behavior belong in focused internal packages.
- Workers call Nix.Api through `internal/workerapi`. They do not import backend implementation concepts, connect to Postgres, evaluate permissions or invent tenant context.
- Worker source and destination bytes move only through short-lived capability URLs. Validate URL scheme/origin policy, bound request and response sizes, refuse redirects unless the capability contract explicitly requires them, and clean temporary files on every terminal path.
- Job handling is lease based and retry safe. Honor cancellation, idempotency keys, attempt limits and lease loss. A process crash must leave work recoverable without duplicating durable workspace mutations.
- Streaming is the default. Bound archive entries, XML/JSON depth, decompressed size, path shape and concurrency. Never materialize a whole workspace merely because a test fixture is small.
- Import/export formats preserve explicit omission and loss reporting. `.nix` is the lossless contract; Markdown, DOCX and PDF are fidelity-checked projections.
- The index is derived state. Every write is an idempotent upsert/delete keyed by tenant and item identity; full rebuild and stale-document recovery must remain possible.
- `/healthz` reports process liveness. `/readyz` reports required dependency readiness. Do not report ready before Nix.Api, object transfer or OpenSearch dependencies required by that role are usable.

## Backend memory rules

Prefer, in order: (1) stream end-to-end, (2) `Span<T>`, (3) `Memory<T>` across awaits, (4) `IMemoryOwner<T>` for ownership transfer, (5) `ArrayPool<T>` in try/finally, (6) `RecyclableMemoryStream` from the singleton manager, (7) `byte[]` only when an external API forces it — and then annotate `// byte[]: <reason>`. No per-request allocations over 85 KB. No LINQ in hot loops. Workstation GC is the deployment reality: the compact tier budget for Core is 150–250 MB resident.

## Backend style

- **Minimal APIs only — no MVC controllers.** No type deriving from `ControllerBase` or `Controller`, no `[ApiController]`, no `AddControllers()`/`MapControllers()`, no `Microsoft.AspNetCore.Mvc` controller infrastructure. Endpoints are registered as minimal API route handlers grouped per feature via `MapGroup` and a `Map<Feature>Endpoints()` extension method. Endpoint delegates stay thin: bind, authorize, call the use case, map the result. A PR introducing a controller is rejected regardless of how convenient it looks.
- `Directory.Build.props` governs: nullable enabled, warnings-as-errors, latest-all analyzers. Never suppress without `// Justification:`.
- Feature folders, one use case per file, `sealed` by default, `record` DTOs, typed IDs (`ItemId`, not `Guid`).
- Result pattern for expected failures; exceptions for bugs and infrastructure faults. Errors surface as RFC 9457 problem details with a stable `code`.
- `AsNoTracking()` by default. **New hot-path SQL attaches `EXPLAIN (ANALYZE, BUFFERS)` output against a realistically sized table — not five seeded rows.** This is the rule most often skipped and the one that has cost most: `GraphSql` shipped documenting three index dependencies, was read four times, and measurement later showed the planner used none of them (a parallel seq scan of all of `item` plus a top-N sort). A doc comment naming an index is a hypothesis; the plan is the evidence, and a statement whose ordering the index cannot serve is the usual reason the two differ.

## Frontend rules

- **Where a new file goes, in one question: what does it know?** Nothing but its own arguments → `lib/` (framework-agnostic, no React) or `a11y/`. Where things sit, but not what is in them → `layout/`. What data a region shows → a feature folder. How the regions fit together → `shell/`. If you cannot answer without saying "it depends", it is two files. The guard rejects the wrong answer; it cannot suggest the right one.
- **Stateless first.** Climb the state ladder and stop at the lowest rung: derive from props → URL → local `useState` → Zustand slice → server-owned. Never mirror props or server data into state by hand.
- Zustand: slices, selector subscriptions only (`useStore(s => s.x)`), actions in the store named as events. Server data enters only through `packages/api-client`'s cache layer.
- Zod at every runtime boundary; types via `z.infer` only. Parse failures are telemetry, not silent fallbacks.
- All HTTP goes through `packages/api-client`. No component imports axios. Every request is cancellable via `AbortController`.
- Browser auth goes through the same-origin `/auth` BFF endpoints. Frontend code must not restore a browser OIDC SDK, persist provider access/refresh tokens, or decode token claims into authorization decisions.
- Workspace identity is part of navigation and cache scope. New authenticated routes live under `/w/:workspaceId`; switching workspaces must abort in-flight workspace requests and clear state that could expose the previous workspace.
- Native canvas changes preserve the versioned interchange parser, Yjs collaboration boundary and scene ceilings. Viewport, selection and pointer state are local UI state and must not be synchronized as document content.
- **Manual `useMemo`/`useCallback`/`memo` needs a reason, written next to it.** The React Compiler is not installed (ADR-0023), so memoization here is hand-written and load-bearing rather than decorative. Three reasons count: (1) the value's *identity* is a dependency of an effect, a subscription, or a third-party API, so an unstable one loops or resubscribes; (2) a profiled cost, with the number in the comment; (3) a contract another library depends on. Deriving a cheap value is not a reason. Never use `useMemo` to *create* something that must survive renders — `useMemo` is a hint the runtime may discard; use `useState(() => new Thing())`. The enforcement is `eslint-plugin-react-hooks` at `recommended-latest`, which is the React Compiler's own rule set (purity, immutability, refs, set-state-in-effect, preserve-manual-memoization) and is already in force in `apps/web` and `packages/ui`.

## No emojis, anywhere

No emojis in code, comments, commit messages, UI copy, logs, error messages, test names, or documentation. Where an icon is needed in the UI, use the icon library (Lucide at stroke 1.5 via the `<Icon>` component) — never an emoji character. Status markers in text use ASCII (`[ ]`, `[x]`, `[SEC]`).

## Styling rules

- **No general CSS.** The only `.css` files are the Tailwind entry per app and the design-token sheet. Utility classes + CVA variants for everything else.
- All colors/fonts/spacing/radii/shadows come from the design tokens (`packages/design-tokens`). Never hard-code a hex, font name, or px value the tokens carry.
- Design grammar: softened corners from the radius scale (`rounded-sm`/`md`/`lg`, sized to the box they turn); hairline `<Blueprint>` frames on cards and figures; cards sit on `bg-surface` with a resting `shadow-sm`; the primary button is the only solid accent object; images through `<Duotone>`; Lucide icons at stroke 1.5; interaction states from the accent ramp with a 2px `:focus-visible` accent ring — never browser defaults. See ADR-0011 for what this replaced and why.
- One typeface, Nunito Sans, headings told apart by weight (`--font-heading-weight`), never by a second family. Self-hosted via `@fontsource`; no font CDN, ever.
- Borders are the last resort, not the first. A surface change (`bg-surface`) or elevation says "these are different regions" without a line; reach for `border-divider` only where two regions of the same colour genuinely meet.
- Body-size accent text uses `--color-accent-text`, not the base accent (contrast). A solid accent fill uses `--color-accent-fill`, which is a separate role because a fill's hover step moves away from the ground while text's moves towards it.
- A component needing a `dark:` variant has reached past the tokens. Semantic roles are already correct on both grounds; ramp steps are not.
- Components compose smaller components: primitives → controls → patterns → feature components → pages. Every `packages/ui` component ships stories for all variants and states, and passes axe.

## Testing rules

- Permission precedence, RLS isolation, and closure correctness are the crown jewels — property-based + exhaustive branch tests, maintained like production code. A permission bug is a breach, not a defect.
- Integration tests run against real Postgres (Testcontainers), each test owning its data (Respawn). RLS tests always use two tenants.
- Port implementations must pass the shared contract-test class for their interface.
- Frontend: Vitest + Testing Library (query by role, not test-id), MSW generated from the OpenAPI contract, Storybook test-runner + axe in CI.
- **`apps/web` test files are not co-located.** Every `*.test.ts(x)` lives under `apps/web/src/tests/`, in a subfolder mirroring the source folder under test (`src/views/board/board-view.tsx` → `src/tests/views/board/board-view.test.tsx`). Shared test helpers (`api-stub.ts`, `render-with-router.tsx`, `setup.ts`, `stub-viewport.ts`, `view-fixture.ts`, `container-fixture.ts`) live at `src/tests/` root. A new source folder gets a matching `src/tests/<folder>/` the first time it needs a test. A test covering a file at `src/` root sits at `src/tests/` root beside the helpers rather than in a subfolder — `app.test.tsx` for `app.tsx`, `app.css.test.ts` for `app.css`.
- **No config tracks the folder layout, so a move needs no config edit.** Vitest's `include` (`src/**/*.test.{ts,tsx}`, in `apps/web/vite.config.ts`) and `apps/web/tsconfig.json`'s `include` are both folder-agnostic, Tailwind auto-detects sources, and `Nix.Frontend.csproj` is pure wildcard globs with no individually-listed entries. What a move *does* need is a sweep of prose: docblocks naming a moved file are invisible to `typecheck`, and are the one thing that goes stale silently.
- Test names are behavior sentences. Don't mock types you don't own.
- Run the relevant test suites before opening a PR; arrive green.

## Stress testing and data queries go through the CLI/MCP (binding)

All stress testing and all querying of a running Nix instance's data go through `nixctl` (the CLI) or
the MCP server — never ad-hoc SQL against the live database, a hand-walked tree, or one-off HTTP
against the services. Driving everything through the two surfaces is how they are built up to genuine
usefulness, and it keeps token-costly hand-walking out of the loop. The full surface and its status
are demonstrated by the CLI/MCP source and tests; do not rely on a removed planning document.

Direct testing — raw SQL, a bespoke script, a direct service call — is the **last resort**, permitted
only when the CLI and the MCP genuinely cannot express what the task needs. The bar for "genuinely
cannot" is high: prefer adding a small command or tool over reaching around the surface. When you do
reach that limit:

1. **Solve the immediate problem directly**, so the task is not blocked, and say plainly in your
   report that you used the direct path and why the surface could not.
2. **Then close the gap in the same session**: extend the CLI *and* the MCP so that class of problem
   is expressible through the tool next time — with a test and the GitHub issue updated the way any
   feature is. A limitation met is a tooling gap to fix, not a
   workaround to keep. The measure of success is that the next agent never needs the direct path you
   just took.

This is a standing rule, not a phase. A stress or query result obtained
by going around the CLI/MCP, without then closing the gap, is not a finished piece of work.

## UI truthfulness

Every data-bearing view renders loading, empty, error, and partial states honestly. Canonical case: a file is downloadable at `clean` but searchable only at `indexed` — the UI must say so.

## Workflow — one task, done to a standard

**GitHub issues are the task record.** `README.md` carries product direction and ADRs carry accepted
architecture. Before starting work, reconcile the issue with the current tree and recent commits;
when they disagree, observed shipped behavior wins and the issue should be corrected. Retired goal
coordinates from removed planning documents are historical references only and must not be reused.

**The measure is the quality of the task, not the number of them.** Throughput is not a goal and
never was a good proxy for one. A task is finished when the work is right, its states are honest,
its reviews are clean and its claims are demonstrated — not when a table row can be ticked. Half a
phase done properly is worth more than a whole one owed back, and the debt is always repaid at a
premium: K15-K20 shipped with their reviews suspended on a spent budget, and the pass that finally
ran over those six goals returned thirteen blockers, including a documented index dependency that
measurement showed was never used and a routing defect that meant three destinations could not open
the note they were pointing at. None of it was cheaper for having waited.

Practically, that means: **finish one thing at a time**, in its own worktree on a focused issue or
`feature/<slug>` branch, inside its lane's directories. Prefer a smaller scope done
completely to a larger one done provisionally. If the scope turns out to be wrong, say so and stop —
do not deliver a narrower thing and describe it as the whole.

**Do not assert what you have not observed.** A doc comment naming an index is not evidence the
planner picks it; a class contract asserted in jsdom is not evidence of rendered layout; a green
suite is not evidence a guard matches what it claims to. Where a claim cannot be demonstrated in
this environment — no Docker daemon, no real browser, no screen reader — write down that it is
asserted rather than proved, and say which of the two it is.

### Commit rules (binding, no exceptions)

1. **One task → one commit.** Format: Conventional Commits, `type(scope): imperative summary`, optional short body explaining why. Where the goal carries a pre-written message, use it verbatim.
2. **Never mention Claude, AI, agents, or code generation** in any commit message, body, or trailer. **No `Co-Authored-By` or `Generated with` trailers of any kind.** This overrides any default commit-attribution behavior.
3. **Never commit markdown or docs.** `*.md`, `docs/`, `.claude/`, and the design-review folder are gitignored — do not `git add -f` them unless the owner explicitly asks for a specific file. If a commit would include a `.md` file, stop.
4. **Stage explicitly by path.** `git add <specific files>`. `git add -A`, `git add .`, and `git commit -a` are banned.
5. **Green before commit:** run the relevant test suites, lint, and build first. The commit marks the work done — it never precedes verification.
6. Implementation agents never push to or commit on `main`; the orchestrator rebases branches and fast-forward merges in dependency order.
7. **Never use `codex` in a branch name.** Use the issue's established branch when one exists; standalone feature work uses `feature/<slug>`.

### Reviews

- Specialist reviewers before every commit, by domain: `customer-ux-guardian` (UI/design/a11y/state honesty), `dev-experience-guardian` (structure/SOLID/DX — all new modules and restructures), `perf-memory-auditor` (backend I/O, per-request code, stores, client, dependencies), `security-reviewer` (**every `[SEC]` change** — authz, RLS, tokens, `/internal`, migrations, and any bulk read), `backend-data-specialist` (SQL, query plans, indexes, migrations, persistence readers). Findings are fix-or-ADR.
- **The specialists judge; they do not implement.** Where a change is well understood, a specialist writes an implementation and test plan and the Sonnet `implementer` executes it — the plan's shape is specified at the bottom of `.claude/agents/implementer.md`. The implementer makes no design decisions: an underspecified step is a halt, not a gap for it to fill. Work that needs judgment at every step is not plan-shaped, and the specialist keeps it.
- **The agents reference the rules; they do not restate them.** If a specialist reports that its own definition contradicts `AGENTS.md` or an ADR, fix the definition — that report is the mechanism working. Both review agents once spent weeks enforcing architectures the project had already abandoned (a pre-ADR-0011 design grammar, a pre-ADR-0015 project layout) because their prompts had copied the rules inline.
- **The reviews are not a budget line and are not suspendable.** They are what "done" means. A review deferred is not saved, it is borrowed: the one place that rule was waived cost thirteen blockers and four owed ADRs, found later and more expensively than they would have been found first. If there is not room to review a change, there was not room to make it.
- [SEC] goals (authz, RLS, tokens, `/internal`, migrations) additionally require owner approval **before** merge. Retrospective approval is not approval — once the code is merged the gate has already failed, and the surface stays unreviewed authorization surface until somebody reads it.
- OpenAPI breaking changes need the `api-breaking` label + an ADR.
- **Never trust a remembered ADR inventory.** List `docs/adr/` immediately before assigning or citing a number, verify that the referenced file exists, and do not fill an apparent historical gap without owner direction. The current worker decision is ADR-0046 and personal-workspace/JIT policy is ADR-0045.
