# Nix — the MVP sequence

**This document is self-contained.** It describes what Nix is today (MVP-0) and the remaining work
in priority order. It does not depend on
`docs/nix-mvp-plan.md` for any of its meaning. Where that document is mentioned, it is as a
historical record — the reasoning behind decisions already made — never as a place a reader must go
to understand what to build next. Appendix B maps this document's coordinates onto the labels older
ADRs and commit messages use, so nothing that already points somewhere stops resolving.

Written 2026-08-14 and reconciled with `main` on 2026-08-16 after the structured-view and deployment
work landed. **Reshaped five times since**, and the sequence below is the current shape:

- **2026-08-14** — the extension platform and the file model dropped outright, external sync cut back
  to a calendar, stability made the whole near plan.
- **2026-08-15, morning** — the scope closed: the product declared functionally complete, with tasks,
  templates, computed properties and the calendar integration all retired.
- **2026-08-15, later** — reopened and resequenced by the owner. Templates, computed properties and
  tasks came back as the top three priorities; multiple workspaces, an MCP server and a CLI were
  added; a stress test became a requirement of every phase; and **every phase was renumbered** so the
  sequence reads in priority order. Appendix B maps every old coordinate onto its new home.
- **2026-08-16** — Spreadsheet view, Quick Form, Smart Lists, composed views, Interactive Form,
  guided structured-view setup and the initial production manifests moved into MVP-0. Their completed
  rows were removed from the active tables; partially completed rows now say only what remains.
- **2026-08-17** — workspace-authored, file-backed and boot-managed templates shipped with measured
  large-container rendering. MVP-1's completed rows moved out of its active table.

Retired for good, across every revision: the plugin platform, the file model, the calendar integration
including Google Calendar sync and the ICS feed, the Obsidian sync, and the presence and canvas-embed
remainder. §12 records each with what the exclusion costs.

---

## How to read this

**An MVP is a sentence a person would say**, not a bundle of related work. If a phase cannot be
stated as something somebody can now do that they could not do before, it is not a phase — it is a
list, and lists have no exit criteria.

**MVP-0 is not a plan.** It is the product as it exists, written down so the phases after it can
hold only what is left. Everything in §2 is merged and running; if a line in it is wrong, that is a
bug report, not a goal.

**The order is the priority.** As of 2026-08-15 there is no backlog and no separately scheduled
phase: MVP-1 through MVP-9 are one sequence, numbered in the order somebody intends to do them. That
replaced a shape in which MVP-5 (then numbered MVP-1) was the only scheduled phase and everything
after it was explicitly not a queue. A number is a commitment to sequence, not to a date.

**Every goal carries a coordinate** — `6.2` is the second goal of MVP-6 — and coordinates are never
reused or renumbered. A goal that is reached moves to a "what this phase delivered" note and leaves
the table, so a table with four rows is four rows of work. **A phase that is dropped keeps its
number and is retired** (§12): MVP-2, MVP-3, MVP-1, MVP-9, MVP-2 and MVP-11 are retired, which is
why the sequence had gaps in it. **On 2026-08-15 the gaps were closed by renumbering**, which broke
that rule on purpose: a sequence that reads in priority order was judged worth more than references
that resolve without a lookup. Appendix B is the lookup.

**Every phase carries:** an exit criterion that can be checked rather than asserted, at most one
database migration, a performance row, **a stress test**, and an explicit note of what it
deliberately does not do.

**The stress test is not the performance row.** The performance row is a budget — a number the phase
must not regress. The stress test is an *amount*: the phase's own work, done at a scale nobody would
do by hand, to find the thing that only breaks when there is a lot of it. A phase does not exit
until its stress test has been run and the result written down, and "it was fine" is not a result —
a number is.

**Notation.** `[SEC]` marks a goal touching authorization, tokens, RLS, `/internal` or migrations —
those need owner approval before merge, not just review. `[MIG]` marks the phase's migration.
`[ADR]` marks a goal that must not be built before its decision is written down. Status markers are
ASCII (`[ ]`, `[x]`); there are no emojis anywhere in this repository, including here.

---

## Roadmap at a glance

The active tables contain only unfinished work. Completed capabilities belong in MVP-0 and in the
short delivery notes beneath the phase they came from.

| Priority | Phase | Remaining outcome |
|---|---|---|
| 1 | MVP-2 — Compute | Formula properties, rollups and charts |
| 2 | MVP-3 — Run the week | Task semantics, assignment, recurrence, reminders and richer task interaction |
| 3 | MVP-4 — Memory | Browse, compare and restore named document versions |
| 4 | MVP-5 — Trust | Close the review, accessibility, performance and known-defect debt |
| 5 | MVP-6 — Operate | Tested backup/restore, observability, security contact and operating budgets |
| 6 | MVP-7 — Import | `.nix`, Markdown, DOCX and PDF import with hostile-input hardening |
| 7 | MVP-8 — Workspaces | Multiple workspaces, roles, invitations and live revocation |
| 8 | MVP-9 — Beyond the browser | Principal-scoped CLI and MCP access |

---

## 1. The fixed constraints

These are true of every phase and are not restated inside them.

**The product.** A premium collaborative document workspace, self-hosted, serving a trusted team of
about ten people. Not multi-tenant in the commercial sense; only explicitly published forms are
public-facing. There is no public workspace reader, no marketplace, and —
as of 2026-08-14 — **not extensible**: there is no plugin runtime and there is no plan for one. That
sizing is a decision, not an accident, and §12 and §13 record what it excludes.

**The scope, reopened and resequenced 2026-08-15.** It was closed earlier the same day — the product
declared functionally complete, with four things owed. That lasted hours. The owner then reinstated
templates, computed properties and task management as the *top three* priorities, added multiple
workspaces, an MCP server and a CLI, and required a stress test at the end of every phase.

**That history is recorded rather than tidied away, because it is the useful part.** A plan that
shows only its current state teaches nothing about how much it moves; this one closed and reopened
inside a day. The standing rule that survives is narrower than a scope statement: **nine phases, in
the order they are numbered, and a tenth needs an argument made in writing.**

What the sequence now says, in priority order: shape the workspace (MVP-1), compute with it (MVP-2),
run your week in it (MVP-3), go back to yesterday (MVP-4), make what exists provable (MVP-5), be able
to restore it (MVP-6), bring work in (MVP-7), keep bodies of work apart and know who is in them
(MVP-8), and reach it without a browser (MVP-9).

**One consequence worth naming.** MVP-5 — the phase that converts §2.4's asserted list into a proved
one — is now fifth rather than first. Its own text argues against that: every phase before it adds
surface, one of the six unproved items is an authorization endpoint, and unreviewed authorization
code is the most expensive thing to build on top of. That was the owner's call and it is recorded
here so the cost is visible if it arrives.

**The stack.** ASP.NET Core 10 with Postgres 16 (RLS, pgvector) for Core; Node 22 and TypeScript for
the collaboration and media services; React 19, TypeScript strict, Tailwind v4, Zod and Zustand for
the web application; OIDC (Zitadel first, multi-issuer by design) for authentication.

**The architecture rules that outlive any phase:**

- **There is one kind of item.** Every item has a body, can hold children, can declare a property
  schema, and can offer views over its children. There is no "folder".
- **Two axes, kept apart.** An item's *body* (`item.type`, an open string) draws its own content; its
  *views* (`item.views`, a closed server-validated set) draw its children. A request for a new way of
  looking at children is a view; a request for a new kind of thing to be is a body.
- **One authorization code path.** Permission filtering happens *during* query evaluation, never
  after. The client never computes permissions. A cache in front of the authorization port caches its
  answers, never its absence.
- **Fail closed, and prove it.** An unrecognised issuer, a deprovisioned principal, an unparseable
  policy: the answer is no, and a test asserts the no.
- **Derived data stays rebuildable.** Closure, snapshots, search vectors, links and embeddings are
  all reconstructible from durable data.
- **File bytes never pass through Core**, and the media service holds no database credentials, ever.
  This survives the retirement of the file model: the media service still converts documents, and
  what it may reach is unchanged.
- **A permission bug is a breach, not a defect.**

**The budgets.** Core resident memory 150-250 MB under Workstation GC; no per-request allocation over
85 KB; request bodies bounded before the payload is copied; hot-path SQL ships with `EXPLAIN`;
frontend bundle 2,420 kB minified / 744 kB gzip JS and 90 kB CSS. A phase does not exit having
regressed one of these.

**Honesty is a requirement, not a polish item.** Every data-bearing view renders loading, empty,
error and partial states truthfully. The canonical case is a search index that has not caught up with
a document — the interface says so rather than implying completeness.

---

## 2. MVP-0 — Nix as it stands [x]

> "I can write, organise, link, search, look at, draw, calculate and leave with my work — alone or
> alongside my colleagues, on a phone or at a desk."

Everything in this section is merged on `main` and running. It is the baseline every later phase is
measured against.

### 2.1 What a person can do today

- **Sign in** through OIDC against Zitadel, with multi-issuer support and PKCE, tokens held in memory
  only.
- **Write notes** in a rich editor: headings, lists, tasks, quotes, code, callouts, tables, images,
  links, columns, collapsible sections, coloured text and highlight, block drag handles, a slash
  menu, and a reference picker on `[[` and `@`.
- **Organise them in a tree**: nest, expand, collapse, create in place, name on creation, breadcrumbs,
  drag to reparent, move with cycle checking, and delete with an Undo toast over a real restore path.
- **Never lose a keystroke**: every document is a CRDT (`Y.Doc`) over an append-only update log, with
  snapshots that are rebuildable from that log and never a source of truth.
- **Work together, live**: a WebSocket collaboration service with an authorization handshake, sync and
  awareness, presence ("who else is here") for every body kind, live cursors in prose, and a
  six-state connection indicator.
- **Choose what a thing is**: three body kinds behind one dispatch seam — a **note** (prose), a
  **canvas** (an Excalidraw scene in the shared document, with a per-person shape library that
  follows them between drawings), and a **spreadsheet** (a free-form grid with A1 addressing and a
  real formula engine — references, ranges, about 26 functions, a dependency graph with cycle
  detection, a bounded operation budget — run identically in the browser and on the server so a
  formula's value can never disagree between them).
- **Give items properties** with schemas that cascade from ancestors and are validated on write, and
  edit every known property type in place.
- **Look at and create children through structured views**: list, board, calendar, gallery, timeline,
  spreadsheet, Quick Form, Interactive Form and server-backed Smart List. A primary view may show one
  companion below or beside it, with independent URL state.
- **Configure structured work through a guided studio**: Board, Calendar, Timeline, Gallery,
  Spreadsheet view, List, Quick Form, Interactive Form and Smart List share a multi-step setup flow
  for new and existing views. Drafts survive the tab, and complex setup no longer lives in the
  right-hand Views pane.
- **Shape a workspace with templates**: capture an item as an independent template, browse and edit
  the workspace library, apply it without replacing existing work, create from it, or carry it as a
  validated `.nix` file. Kanban, Calendar and List use the same catalog rather than client presets.
- **Publish an Interactive Form** through an opaque, revocable link. Public respondents see only the
  sanitized multi-page form; answers are mapped to declared properties and become ordinary child
  items that every other view can use.
- **Link and find**: `[[` and `@` references with four resolution states, a backlinks panel, full-text
  search across titles and document contents, and a command palette that opens anywhere and asks the
  server rather than filtering what the tree happens to have loaded.
- **Reach the workspace from a rail** of five destinations: Notes, Calendar (every calendar view in
  the workspace collated into one, filterable, with drag-to-another-day), Graph (the workspace as
  nodes with containment and reference edges, zoomable and draggable, with a text tree beside the
  picture for anyone who cannot see it), Bookmarks (a personal shelf, permission-filtered, honest
  about what it is hiding), and Templates.
- **Work in two panes side by side**, as a list in the URL, with a draggable keyboard-operable
  divider and per-pane document tabs (preview versus pinned, closable).
- **Leave with the work**: export a document or a subtree as a lossless `.nix` archive, a PDF or a
  DOCX — with each format stating what it cannot carry *before* the export runs, and the produced
  file repeating it. An item's views are drawn into its exports as SVG (vector in PDF, rasterised for
  Word).
- **On a phone**: below the `sm` breakpoint the sidebar is an off-canvas drawer, the calendar grids
  scroll rather than compress, and a multi-pane arrangement collapses to one.

### 2.2 What exists behind that

| Area | State |
|---|---|
| **Core (ASP.NET Core 10)** | One project, dependency direction carried by folders (`Domain` -> `Abstractions` -> `Persistence` -> `Features`) and enforced by a CI guard. Minimal APIs only, no controllers. CQRS messages through a hand-written dispatcher with explicit registration. Feature slices: Items, Views, Properties, Permissions, Roles, Search, Graph, Calendar, Bookmarks, Canvas, Me, Workspaces, Internal, Health |
| **Database** | Postgres 16 with `FORCE ROW LEVEL SECURITY` on every tenant-scoped table, `SET LOCAL` session context, a closure table maintained on every move, content tables with a grant split (Core reads, the collaboration service writes), `item_link`, `item_search`, `canvas_library`, bookmarks, tenant-scoped public-form links and hidden versioned template trees |
| **Collaboration service (Node 22)** | Document lifecycle from snapshot plus tail, flush thresholds, idle eviction with drain, per-body-kind validation stated once and used by both the socket and the HTTP append path, link and search extraction where the merged document exists, staged template body cloning, and the `.nix` archive and bundle stream |
| **Media service (Node 22)** | PDF and DOCX conversion plus bounded hostile-input validation for template-profile `.nix` archives. No OIDC of its own (it forwards the caller's token; the collaboration service authorizes through Core, so there is one authorization path), and **no database credentials, refused at boot** rather than merely absent. Admission bounds output bytes, bundle bytes, job time and concurrency |
| **Web application (React 19)** | Four-tier layering (`lib`/`a11y` -> `layout` -> features -> `shell`) enforced by a CI guard with no exemption marker. Routes include editor, calendar, graph, bookmarks, templates, guided structured-view setup, public forms, token gallery and auth callbacks |
| **Packages** | `@nix/ui` (primitives, controls, patterns, every component with stories and an axe pass), `@nix/design-tokens` (type, spacing, radius, shadow, colour ramps, dark palette, print palette), `@nix/editor-schema` (schema v2 with a version pin raised by a job, not a client), `@nix/api-client` (generated from the published OpenAPI contract), `@nix/sheet`, `@nix/export`, `@nix/pdf-export`, `@nix/docx-export`, `@nix/view-render`, `@nix/collab` |
| **Contract** | `backend/openapi/nix-api.json` is the seam; the backend build regenerates it and CI fails on any uncommitted difference; the typed client is generated from it and verified in CI |
| **Guards in CI** | Backend: layering, no-controllers, byte-array markers, unambiguous root. Frontend: raw design values, spacing roles, text primitive, frontend layering — each with a self-test that runs first, against its own fixture corpus |
| **Security posture** | Request bodies bounded at 256 KB (2 MiB for the canvas library, applied after routing), rate limiting on writes and failed token validation keyed on the forwarded client address, a content-security-policy shipped in both the document and the reverse proxy and kept in step by a test that parses both |
| **Deployment** | Production Docker builds and Kubernetes definitions for Postgres, Core, collaboration, media and web, with migration, seed, ingress, backup, verification, preset and managed-template reconciliation jobs. Media receives no database credential and declares restricted egress |

### 2.3 What MVP-0 does *not* include

Stated plainly, because a baseline that overstates itself makes every later estimate wrong. Two of
these are now permanent rather than owed, and are marked as such.

- **No files — permanent.** No upload, no attachments, no object storage in the product path. Cover
  images are addresses somebody pastes or drags in, not file references, and that is now the shape of
  the product rather than a gap in it (§12, retired MVP-2).
- **No plugins — permanent.** No extension runtime, no capability API, no third-party code of any
  kind (§12, retired MVP-9).
- **No general import.** A bounded template-profile `.nix` archive can enter the template library;
  ordinary `.nix`, Markdown, DOCX and PDF imports remain MVP-7.
- **No tasks in the product sense.** Completion, due dates, priorities and recurrence are conventions
  a person can build from properties, not first-class semantics, and there are no reminders.
- **No roles or invitations.** Workspace membership gates access and the member list is readable, but
  nothing in the product invites somebody, removes them, or changes what they may do. There is no
  settings or administration screen.
- **No version history.** The update log makes it possible; nothing surfaces it.
- **No formulas over properties**, no rollups, no charts, no calendar integrations.
- **No trash.** Deletion has an Undo toast with a two-slot queue and nothing past it.
- **No completed operating story.** Kubernetes manifests, hardened service deployments and a
  scheduled Postgres dump now exist. The key-ring backup, documented restore drill and production
  observability remain open in MVP-6.

### 2.4 What is proved, and what is only asserted

This distinction is the reason MVP-5 exists. It was the only scheduled phase until 2026-08-15; it is now fifth, and §1 records what that risks.

**Proved.** Closure correctness (property-based against a from-scratch recomputation), cycle
rejection, RLS isolation across two tenants on real Postgres, permission refusals asserted as
refusals, schema round-trips, the formula engine's safety properties, every converter's declared loss
against a document of every block, and the component library's axe pass in a real browser on every
pull request.

**Asserted but not observed.** Six things, and each is a specific piece of work in MVP-5:

1. **Six goals shipped without their specialist reviews** (the rail, the graph, the collated
   calendar, the shelf, the highlight control and the workspace graph endpoint) — a deliberate
   suspension on a spent budget, not an oversight.
2. **A [SEC] endpoint merged without its owner approval** (the workspace graph read), which makes the
   approval retrospective rather than a gate.
3. **Responsive and accessibility claims are pinned as class contracts in jsdom**, which performs no
   layout: the hit targets, the gutter bleed and the reveal-on-focus states are reasoned, not seen.
   No screen-reader pass has ever been run.
4. **Search's query shape was chosen against a corpus of five rows.** The two-arm index-driven
   statement can use the indexes; nothing has shown that it does at scale.
5. **Nothing exported has been opened by a person** in Word, in a PDF reader, or as an archive.
6. **The content-security-policy has never been exercised by a real signed-in session**, and its whole
   risk is that it breaks sign-in silently.

**Test counts, taken 2026-08-14 at `26f990e`, all green.** 379 backend unit; 2,075 across the
frontend workspace — `apps/web` 1,130 in 88 files, `packages/ui` 221 (plus 163 Storybook stories in
18 files, swept by axe in a real browser on every pull request), `apps/collab` 197, `packages/editor-schema` 138, `packages/sheet`
111, `packages/design-tokens` 87, `packages/api-client` 64, `apps/media` 40, `packages/export` 38,
`packages/view-render` 18, `packages/pdf-export` 16, `packages/docx-export` 15. **The backend
integration suite was not re-run for this count** — it needs a Docker daemon and real Postgres, and
it was last measured at 205 or so cases.

**Known defects carried into MVP-5.** Canvas content does not reliably survive close and reopen; nine
hooks in the web application talk to Core with raw `fetch` instead of the generated client; a
collaboration-service test harness reproducibly logs an unhandled rejection that makes a green suite
exit non-zero; `packages/export/src/loss.ts` contains a literal NUL byte that makes git treat the file
as binary; the development issuer default points at a port nothing serves; and the frontend bundle
budget is enforced by nothing.

---

## 3. MVP-1 — A workspace you can shape [x]

> "We set it up the way we work, and we can send that setup to somebody else."

There is no remaining work in this phase.

**Exit:** a team sets up its own schemas, views and starting points without a developer, carries them
out as files and brings them back, and a container of several thousand children stays responsive.

**Delivered from this phase:** 1.1–1.5, 1.8 and 1.9. A workspace can author, stage, edit, apply and
share hidden versioned template trees; Kanban, Calendar and List are catalog seed data. Application
is preflighted, atomic and idempotent. Template-profile `.nix` files round-trip through a bounded
hostile-input reader, and a post-health deployment job reconciles managed files with short-lived OIDC
credentials. The library, New menu and item-header studios use the same API-backed catalog; templates
remain absent from the Views panel. List and Gallery render measured windows, with bounded Board and
Timeline rendering at scale. The tracked 3,200-child browser proof records 918.73 ms ready time,
43.39–224.09 ms view switches, at most 84 rendered List/Gallery entries, 24.70 ms worst p95
scrolling, no long task over 100 ms, bounded five-cycle heap growth and idempotent reapplication.

Also delivered: 1.6, Spreadsheet view. Children are editable rows, properties are columns, and the
grid supports range selection, fill and TSV clipboard operations. The guided studio now creates and
reconfigures it; that setup UX is baseline rather than a remaining template goal.

## 4. MVP-2 — A workspace that computes [ ]

> "I can calculate with my data without exporting it to a spreadsheet."

Kept in the narrowed scope because rollups are how a container answers "how much of this is done",
which is project-management work, and a chart is a way of looking at children.

| # | Goal | Notes |
|---|---|---|
| 2.1 | **Formula property type**: an expression over an item's own properties, evaluated on read, with a stated function set. Built on the formula engine that already ships rather than a second one | |
| 2.2 | **Rollups**: aggregate a property across an item's children — count, sum, min, max, average, any, all | |
| 2.3 | Charts: a summary view over children, counts and sums grouped by a property | |
| 2.4 | Performance: evaluation is bounded in time and memory and does not turn a list render into a dependency walk | The performance row |
| 2.5 | **Stress test**: a rollup over 3,000+ children, and a formula chain deep enough to matter, recomputed on a write. The failure this looks for is a dependency walk that turns one edit into a full recalculation | The stress row |

**Exit:** a property can be computed from its item and from its children, and the numbers are right
in the same places a person would check them.

## 5. MVP-3 — A workspace you can run your week in [ ]

> "I can plan my week in it, be reminded, and see what is late — without opening a task manager."

**Why here.** It is the project-management half of the narrowed scope, it sits almost entirely on
properties and views that already exist, and it is the first phase that makes Nix somebody's daily
tool rather than their document store. Its permission-filtered server-side query foundation now
ships; the task-specific semantics around it remain.

| # | Goal | Notes |
|---|---|---|
| 3.1 [MIG] | **Task semantics**: completion, due date, start date, priority, estimate as first-class property types rather than conventions. Carries the storage recurrence and reminders also need, so they do not each arrive asking for their own | The one migration |
| 3.2 | **Recurring tasks**: a rule on an item, next-occurrence materialisation, completing one instance without disturbing the series | |
| 3.3 | **Reminders that actually fire**: in-app, browser notification and email, with the mail relay a named deployment dependency and a delivery failure that is visible. **Not built until one arrives on a device with the tab closed** — a badge that appears when you happen to be looking is not a reminder | |
| 3.4 | **Finish task-aware Smart Lists**: add Assigned to me after 3.5 supplies a principal-typed property, then bind the shipped Today, Next 7 days and Overdue starters to 3.1's canonical task fields rather than workspace conventions | The saved query item, AND filters, server execution and the first three starters already ship |
| 3.5 | Assignment: a principal-typed property, an assignee filter on every view, a workload read | |
| 3.6 | Checklist view: a compact ordered view over children with completion, reordering and quick add | |
| 3.7 | Dependencies between items, drawn on the timeline; drag and resize on timeline bars with keyboard parity | |
| 3.8 | Arrow-key navigation across list cells, matching the keyboard model the spreadsheet grid already ships | |
| 3.9 | Performance: the tree, the smart lists and the timeline over 10k items in one workspace | The performance row |
| 3.10 | **Choose where a collated-calendar entry lands**: today every entry created from `/calendar` goes to the workspace's default container, whatever the note filter says. Sending it to a filtered note instead needs a way to resolve *that container's own* date property — the collated payload rewrites every entry onto one key, so a page cannot tell what a note places by unless that note happens to have an entry in the window on screen. Building it on that would make the destination depend on which month you were looking at | Deferred from the MVP-5 deviation above, deliberately and with the reason recorded |
| 3.11 | **The default calendar container's second half**: a workspace setting that designates an existing container instead of accepting the auto-created one, and an answer for what happens to entries already in the old one. The auto-create was chosen as the whole of it on purpose - it needs no settings surface, no picker and no empty state - and this is the part that was left | |
| 3.12 | **Recurring calendar entries**: the calendar's own half of 3.2 — a repeating entry on a date property, an occurrence edited or skipped without breaking the series, and a series ended from any occurrence. Distinct from a recurring task because the collated calendar spans containers and an occurrence has to resolve to one | Added 2026-08-14 with the narrowed scope, which names recurring calendars explicitly |
| 3.13 | **Stress test**: 3,000+ items carrying dates and assignees, across a smart list, a calendar month and a timeline, with a recurrence expanding into the window on screen | The stress row |

**Exit:** a person plans a week, is reminded of it away from the tab, and sees what is late, without
leaving Nix.

**Delivered from this phase:** the cross-container query endpoint evaluates saved AND-combined
filters inside the permission-filtered server query. Smart List items and the Today, Next 7 days and
Overdue starting points are configurable through the guided studio. Assigned to me intentionally
waits for 3.5 rather than guessing at identity through a text property.

**Deliberately not here:** habit tracking and pomodoro timers. They have their own data model and
their own screens and do not compose with a document workspace. With no extension platform to defer
them to, they are simply not planned — §12 holds them.

## 6. MVP-4 — A workspace with a memory [ ]

> "I can go back to yesterday's version."

**Cut back on 2026-08-15** to its memory half. The live half — 4.1's presence remainder and 4.3's
canvas embeds — is retired (§12); what survives is version history, which is not a feature so much as
the expectation that ten people editing the same documents will eventually overwrite each other's
work. Backup (MVP-6) is the wrong granularity for that: it restores a database, not a paragraph.

It is also mostly exposure rather than construction. The update log has been accumulating since the
first note, so the storage already exists and always did.

| # | Goal | Notes |
|---|---|---|
| 4.2 | **Version history**: named versions, browse, compare, restore — over the update log that has been accumulating since the first note | |
| 4.4 | Performance: history browsing does not materialise a document per revision | The performance row |
| 4.5 | **Stress test**: a document with a long edit history — thousands of updates from several authors — browsed, compared and restored, without materialising a document per revision | The stress row |

**4.1 and 4.3 are retired**, not renumbered. The phase is 4.2 and 4.4.

**No migration** — the storage model is the one the first phase established. **Exit:** any document
can be returned to a named earlier state.

## 7. MVP-5 — A workspace you can trust [ ]

> "Everything it already does, it does provably — and the things that are broken are fixed."

**Why it is the whole plan.** Every phase after this one adds surface. Adding surface on top of
unreviewed authorization code, unmeasured queries and unheard announcements compounds the cost of
fixing them, and one of the six unproved items is an authorization endpoint. This phase adds no
features on purpose: it converts §2.4 from a list of assertions into a list of facts. As of
2026-08-14 it was not merely first — it was the only thing scheduled. **That changed on 2026-08-15**: it is now fifth, behind three feature phases and version history, and the argument below is left standing rather than rewritten because it is the cost of that decision
until it exits.

| # | Goal | Notes |
|---|---|---|
| 5.1 [SEC] | **The reviews six goals did not get**: UX over the rail, calendar, graph, shelf and highlight; structure over the new modules and the layering reorg; performance over both bulk workspace reads and the graph's render path — the one place the product draws every node at once | Findings are fix-or-ADR |
| 5.2 [SEC] | **Retrospective owner approval of the workspace graph read and the bookmark shelf**, both read as unreviewed authorization surface until then. The shelf shipped a migration and three endpoints with deliberately asymmetric refusal behaviour under no [SEC] label at all | |
| 5.3 | **The listening pass**: a screen reader over the live region, the pane labels, the graph's text tree and a toggle's heading behaviour | Cannot be automated; that is why it is still open |
| 5.4 | **The looking pass**: a real browser at 375/768/1024, dragging the pane divider and a column handle, measuring the widened hit targets, watching reveal-on-focus actually render | |
| 5.5 | **Open the exports**: a signed-in export of a real document opened in Word, in a reader, and re-read as an archive — with what is found written down | Nothing in a test distinguishes a correct rasterised view from an ugly one |
| 5.6 | **Sign in with the policy live**: a full session against dev Zitadel with the content-security-policy in force, plus the development issuer port corrected | |
| 5.7 | **Search at scale**: the two-arm statement against a corpus of about 100k documents, with plans and numbers committed to the repository | The phase's performance row |
| 5.8 | **Fix the canvas persistence defect**: content that can appear empty after close and reopen. Root-cause first — the reconciliation layer between Excalidraw's state and the shared map is the first suspect, not the conclusion | |
| 5.9 | **The collaborative-editing pass**: refusal notices surfaced in every body kind rather than only the sheet, presence that says what somebody is doing, and a sync state that is legible rather than one line of small type at the bottom of a pane | |
| 5.10 | **A trash view**: deletion recoverable past the undo window, which is what makes the two-slot toast queue acceptable rather than lossy | |
| 5.11 | **Wire the generated client**: nine hooks moved off raw `fetch` onto `@nix/api-client`, which is built, tested and unused in the application | |
| 5.12 | **Make the budgets gates**: a CI check on the bundle ceiling, and a lockfile vulnerability audit — both are stated policy today and enforced by nothing | |
| 5.13 | **Fix the tooling that costs every contributor**: the headless Storybook hang, the calendar tests' tight timeout, the stale view-kind doc comments, the collaboration harness's unhandled rejection, the jsdom pin mismatch, the ESLint/tsc disagreement, and the NUL byte in the loss report | Each was independently rediscovered by more than one contributor |
| 5.14 | **The switcher row's honest states**, owed by the views-read fix of 2026-08-14 and deferred deliberately because they need copy in a row the container-template goal rebuilds. Three parts, one row: `editor-page.tsx:389` resolves an unreadable views read to `DOCUMENT_VIEW`, so an item shows its body with no word said; a link carrying `?view=` is then **silently ignored**, which is a wrong answer to an explicit request rather than an absence; and `setDefaultView`'s refusal sentence exists in the hook but is discarded by its only caller (`editor-page.tsx:423` voids the return), so switching a view fails to be remembered and says nothing. **Plus a fourth, introduced by that same fix:** when a "Try again" recovers a container, the notice carrying the focused button unmounts and focus falls to `body`, so a keyboard reader restarts from the top of the document. The fix is local — a `useRef` and `tabIndex={-1}` on the pane's leading text, focused on the recovery transition, entirely inside each editor; it needs nothing from `EditorShell`, and an earlier draft of this row wrongly said it did. Deferred only because the defect is reasoned from React's unmount semantics rather than observed, and wants the real keyboard pass of 5.4 first | Deferred with the reviewer's agreement, on condition it was recorded where the next goal meets it rather than only in a commit body |
| 5.15 | **Choose where a collated-calendar entry lands**: today every entry created from `/calendar` goes to the workspace's default container, whatever the note filter says. Sending it to a filtered note instead needs a way to resolve *that container's own* date property — the collated payload rewrites every entry onto one key, so a page cannot tell what a note places by unless that note happens to have an entry in the window on screen. Building it on that would make the destination depend on which month you were looking at | Was 3.10. Moved here 2026-08-15 when MVP-3 was retired: it is a shipped feature sending work to the wrong place, not a new one |
| 5.16 | **The default calendar container's second half**: a workspace setting that designates an existing container instead of accepting the auto-created one, and an answer for what happens to entries already in the old one. The auto-create was chosen as the whole of it on purpose — it needs no settings surface, no picker and no empty state — and this is the part that was left | Was 3.11. Moved here for the same reason |
| 5.17 | **Stress test**: the whole workspace at the scale MVP-1 established — 3,000+ children in one container, several such containers, two people editing at once — walked with a keyboard and a screen reader. This phase is about what is true rather than what is fast, and an accessibility claim that only holds on a short list is not a claim | The stress row |

**~~No migration.~~ One migration, taken 2026-08-14 — a deviation, recorded rather than smoothed
over.** `20260814182737_DefaultCalendarContainer` adds one nullable `default_calendar_item_id`
column to `workspace`, and with it `POST /api/v1/workspaces/{id}/calendar/entries`: the collated
calendar could show every calendar in the workspace but could not add to one, because it spans many
containers and "add an entry" had no answer to "under what?". The column is that answer. Owner
decision on scope: one default per workspace, auto-created on first use, the container a server
implementation detail the client cannot name.

**This also breaks the phase's "deliberately not here" rule**, and both breaches should be read
together rather than separately: MVP-5 was defined as a phase that adds no feature, and this adds
one a user will notice. The honest reading is that the work belonged to MVP-3 ("a workspace you can
run your week in") and was pulled forward on request. It is recorded here rather than moved because
the migration landed in this phase's window and a phase's migration count is a fact about what was
applied, not about where the work was planned.

**MVP-3 was retired on 2026-08-15**, which changes what this deviation means rather than excusing it.
The calendar it added is now a shipped feature with no phase behind it, so the two parts that were
left — 5.15 and 5.16 above — moved into this phase instead of following MVP-3 into §12. They are the
finish of something that exists, which is what this phase is for.

**What it cost, since a deviation that only records the decision teaches nothing.** The plan behind
it specified a **privilege escalation** — authorizing a write with `ReadableWorkspacesAsync`, which
answers membership in *any* role, so a Viewer could have created a root container and written a
workspace-wide setting. A pre-implementation security review caught it, along with a lock mode that
would have blocked every unrelated item creation in the workspace, and three premises of the plan
that were simply false. A second review after implementation caught a Viewer-refusal test that could
not fail against the escalation it was named for. Every one of those was free to fix at the point it
was found and expensive at any later one. **This is the argument for §13's review gate stated as
evidence rather than as principle**, and it is the same argument 5.1 and 5.2 exist to make about the
six goals that shipped without it.

**Exit:** every item in §2.4's "asserted" list has moved to "proved" or has a written reason it
cannot be, no known defect from §2.4 is open, and the bundle and lockfile gates fail a pull request
rather than a conversation.

**Deliberately not here:** anything a user would notice as new — with the one exception above, which
is a deviation and not a licence for a second.

## 8. MVP-6 — A workspace you can operate [ ]

> "If the machine dies, I get my work back, and I can see what it was doing before it died."

**Why here.** It is stability work rather than functionality, so it is the natural continuation of
MVP-5 and the one phase that could reasonably be merged into it. There is a database holding a team's entire body of work and no
tested way to bring it back; a backup nobody has restored is a hope. It is also the last comfortable
moment to add observability, since every later phase adds a background process.

| # | Goal | Notes |
|---|---|---|
| 6.2 | Backup for Postgres, documented, scheduled, and with the Data Protection key ring included — a lost key ring is an outage and a leaked one is a breach | Object storage is not in this row: there is none, and §12 records why |
| 6.3 | **A restore drill that is actually run**, on a stated cadence, with the result written down | The goal is the drill, not the script |
| 6.4 | Observability across Core and both Node services: structured logs, traces across the service hop, and the handful of metrics that answer "is it healthy" | This has never had a home in any plan |
| 6.5 | A `SECURITY.md` with a contact and a stated response expectation | |
| 6.6 | Performance: a startup-to-serving budget and a resident-memory reading for each service under a realistic workspace, committed | The performance row |
| 6.7 | **Stress test**: the restore drill run against a workspace of realistic size rather than a seeded one, and timed. A restore whose duration nobody knows is a restore nobody has planned around | The stress row |

**No migration. Exit:** a full restore from backup has been performed by a person following the
written procedure, and the three services report enough to diagnose a problem without attaching a
debugger.

**Delivered from this phase:** 6.1. Production Docker builds and Kubernetes manifests cover Core,
collaboration, media and web, plus migration, seed, ingress and verification jobs. Media has no
database secret and carries an explicit egress policy. The scheduled Postgres dump is only part of
6.2: key-ring handling and the restore procedure remain open.

## 9. MVP-7 — A workspace you can bring your work into [ ]

> "I can bring my old work in, and what it could not bring in, it told me."

**Why here.** Export already ships; the round trip is what makes the anti-lock-in claim true in both
directions, and importing is the honest test of whether the document model captured everything. It
is one of the four areas the scope is now fixed to.

| # | Goal | Notes |
|---|---|---|
| 7.1 | **Import from `.nix`**: the exact inverse of the archive export, round-trip tested — a workspace exported and re-imported is the same workspace | Stays in Core |
| 7.2 | **Export to Markdown**: a document and a subtree, front matter carrying properties | Reworded 2026-08-14: it used to say "and an attachment folder", which the retirement of the file model makes meaningless |
| 7.3 | **Import from Markdown**: files or a folder tree, front matter to properties, wiki links resolved where they can be. An image reference that points at a local file becomes an address or an honest unresolved reference — never a silently dropped one | |
| 7.4 | **Import from DOCX and PDF**: DOCX by structure; PDF by extracted text with an honest statement that layout is not preserved | |
| 7.5 | **The import experience**: preview before commit, a report of what was mapped and what was dropped, and an undo — rendered by the host so every format reports the same way | |
| 7.6 [SEC] | **Hostile-input hardening**: parsers run inside the media service's existing bounds on memory, time and decompression ratio — the same isolation that already refuses database credentials at boot. A DOCX is a zip and is treated as hostile — zip bombs, entity expansion, a million-row table — and imported markup is sanitised before it becomes a document. A corpus of hostile fixtures is refused in tests | Gates the phase |
| 7.7 | Performance: a 10k-note import completes in bounded memory, streaming end to end | The performance row |
| 7.8 | **Stress test**: a 10,000-note import from Markdown, and a `.nix` round trip of the same, with the mapping report read rather than skimmed | The stress row |

**Exit:** a workspace exports and re-imports with no loss; every lossy path states what it loses
before it runs; and the hostile corpus is refused in CI rather than in review comments.

**Note on what changed here.** This phase used to depend on MVP-2 having hardened the media service
for hostile parsing. With MVP-2 retired, 7.6 carries that hardening itself, and it is the phase gate
rather than an inherited property.

## 10. MVP-8 — Workspaces, and who is in them [ ]

> "I can keep separate bodies of work apart, invite my team to the right one, and know that removing
> somebody takes effect now."

**Why here.** Everything before this is safe because everybody in the workspace already sees
everything. This phase is the first that distinguishes people from each other, and it is deliberately
small: a member and an admin, not a permission matrix.

**Multiple workspaces joined this phase on 2026-08-15**, at the owner's request, and it belongs here
rather than anywhere else because it is the same question asked twice — who may see this body of
work. It is also less than it sounds: the data model already carries it. `Workspace`,
`WorkspaceMember` and workspace-scoped items exist, RLS already isolates by tenant, and the API is
already routed `/{workspaceId}/...`. What is missing is that a workspace cannot be **created** (the
endpoints list and read, and nothing writes), and that the web application assumes there is exactly
one — `app-shell.tsx` says so in its own header comment. So this is a create path, a switcher, and
the isolation proof; it is not a new tenancy model.

| # | Goal | Notes |
|---|---|---|
| 8.1 [MIG] [SEC] | Constraint narrowing deferred from the first schema: the role vocabulary and principal uniqueness | The one migration |
| 8.2 [SEC] | Workspace roles — `member` and `admin` — enforced through the existing authorization port as a check on top of the membership resolver, never as a second path | |
| 8.3 | Invite flow: add a principal by email, remove one, see the member list and each role. This is also the product's first administration screen | |
| 8.4 [SEC] | **Revocation reaches live sessions**: a removed grant closes or downgrades an open socket within a stated, tested bound. The handshake authorizes once, and a socket that outlives its permission is a leak with a keepalive | |
| 8.5 | Performance and correctness: the role check adds no query to the hot path, shown with plans | The performance row |
| 8.6 [SEC] | **Create a workspace**: the one workspace operation that does not exist — today's endpoints list and read only. The creator becomes its admin, and it is seeded with what a workspace needs to be usable rather than empty: the default calendar container and the shipped presets | Added 2026-08-15 |
| 8.7 | **Move between workspaces**: a switcher, and the workspace in the URL so a link resolves to the right one rather than to whichever was last open. The shell assumes exactly one today and says so in `app-shell.tsx`'s header; that assumption is the work | Added 2026-08-15 |
| 8.8 [SEC] | **Isolation proved with two workspaces**, the way the RLS tests already use two tenants: a member of one cannot read, write, search, link to, or see in a calendar or graph anything in the other, by any route. A test asserts each no | Added 2026-08-15. The reason 8.6 is [SEC]: creating a second workspace is what makes cross-workspace leakage reachable at all |
| 8.9 | Rename a workspace, and leave one. **Not** deleting one — a delete that takes a team's entire body of work with it wants a restore path first, and MVP-6 owns that | Added 2026-08-15 |
| 8.10 | **Stress test**: several workspaces holding thousands of items each, with a principal in some and not others, proving isolation under load rather than only in a unit test | The stress row |

**Exit:** an admin creates a second workspace, invites, removes and re-roles somebody in it; every
admin-only write is proven admin-only by a test asserting the no; a removal ends an open session
inside the stated bound; and a member of one workspace is proven unable to reach the other.

**Deliberately not here:** per-item permissions, deny entries, inheritance breaks, an audit pipeline,
or public reading of workspaces and items. The public-form service identity is purpose-built for
submissions and does not become a general anonymous-reader model. Nor **deleting** a workspace, nor
moving items between workspaces — the first wants a tested restore path (MVP-6) and the second is an
import and export problem (MVP-7) wearing different clothes. §12 records why and keeps the design
work findable if the trust model changes.

## 11. MVP-9 — A workspace you can reach without a browser [ ]

> "I can drive it from my terminal, and my tools can drive it too."

**Why here.** Both surfaces are the same thing said twice: a way into the workspace that is not the
web application. They share an API, an authorization story and a shape of error, so building them
apart would mean answering every question twice and eventually differently.

**MCP was retired on 2026-08-14** as part of the plugin platform and is reinstated here on
2026-08-15 as first-party code. That reversal is cheap because what made it expensive is gone: it
does not need a sandbox, a capability broker or a manifest. It is an API surface with the same
authorization path as every other one.

| # | Goal | Notes |
|---|---|---|
| 9.1 [SEC] | **A token a non-browser client can hold**: issued per principal, scoped, revocable, listed and revoked from the same screen that manages members. Never a shared secret, never long-lived without an expiry a person chose | The CLI and MCP both sit on this, and neither is built before it |
| 9.2 | **A CLI**: sign in, list and read items, create and edit, run a search, import and export. It is the scriptable surface, so its output is machine-readable by default and pretty only when a terminal is attached | |
| 9.3 [SEC] | **MCP server**: read, search and write over MCP, authenticated as a principal and scoped by that principal's reach — never more. A tool acting for somebody holds a subset of what they hold, and a test asserts the no | The proof that the model holds when the caller is a program rather than a person |
| 9.4 | Honest failure on both: a refusal says which principal was refused what, an incomplete search says the index is behind, and neither surface invents a success | The states rule applies away from the browser too |
| 9.5 | Performance: a scripted run of a thousand reads does not hold a connection per read, and the CLI starts fast enough to use in a loop | The performance row |
| 9.6 | **Stress test**: an agent driving the MCP server through a realistic session — hundreds of reads, tens of writes, a search and an export — with no leaked authorization and no unbounded response | The stress row |

**Exit:** a person does a real piece of work from the terminal without opening the browser, an agent
does the same over MCP, and every refusal on both paths is proven to be the same refusal the web
application would have given.

**Deliberately not here:** a plugin runtime, a sandbox, or anything that runs code somebody
installed. This is a client of the API, and that distinction is what keeps it small.

---

## 12. Retired work

**Keyed by name, not by number, and that is new.** Until 2026-08-15 a retired phase kept its number
forever on the argument that a reused label resolves to two different things. The renumbering of
2026-08-15 abandoned that rule deliberately — the sequence now reads in priority order, which it
could not do while carrying six gaps — so the numbers below would collide with live phases if they
were kept. They are recorded by what they were instead, with their old label named, and **Appendix B
maps every old coordinate onto its new home** so that an ADR or a commit message written before today
still resolves.

The rule that replaced it: **a phase's number is its position, and Appendix B is the only place old
positions live.**

### Files. Retired 2026-08-14. *(was MVP-2)*

It was the file model: an attachment record with a state timeline, presigned upload, virus scanning
and quarantine in the media service, extraction and thumbnails, PDF viewing in place, cover images as
real file references, and the honest `clean`-versus-`indexed` timeline in the interface. **Goals
2.1-2.8 are retired.**

**Why.** Files fall outside the four areas the scope is now fixed to, and they were the most
expensive phase in the plan: an object store to run, back up and restore; a scanner to deploy and
keep current; a quarantine state machine; and a second class of durable bytes with its own lifecycle,
in a product whose entire value is in documents that are already durable.

**What it costs, stated plainly.** Cover images stay addresses somebody pastes, which means an image
in Nix can rot when something outside Nix moves. There is no way to keep a PDF *with* the note about
it. Markdown import (7.3) meets local image references it cannot resolve, and 7.3 now says what it
does about that instead of assuming an attachment exists. The honest `clean`-versus-`indexed`
timeline was this repository's canonical example of state honesty; §1 now names the search index
instead.

### The calendar integration. Retired 2026-08-15. *(was MVP-11)*

External account connections with OAuth and encrypted token storage in Core, a read-only ICS feed
out, two-way Google Calendar sync, the sync engine with its run log, and the sync performance row.
**Goals 11.1-11.3, 11.5 and 11.6 are retired**, joining 11.4 which was already gone.

**Why.** It is the last thing in the plan that reaches outside the machine Nix runs on, and it is the
most expensive kind of work per unit of benefit: an OAuth flow, credentials that are a breach if they
leak, a rate-limit-aware incremental sync, and conflict rules — all so that dates appear somewhere
else as well. A self-hosted workspace for ten people does not need to be the source of truth for
their calendar.

**What it costs, stated plainly.** Dates live in Nix and are read in Nix. Nothing appears in Google
Calendar, Apple Calendar or Outlook, and there is no ICS feed — the cheap read-only half goes with
the rest, because keeping one integration alive means keeping the reason for integrations alive.

**Two rules lose their last consumer.** The egress proxy rule now has no live consumer at all, and
§1's credential-handling rule has nothing to handle. Both stay written down: they cost nothing while
unused and they are the rules a future integration would have to satisfy before it was allowed.

### Presence remainder and canvas embeds. Retired 2026-08-15. *(was MVP-8, goals 8.1 and 8.3)*

**Goals 4.1 and 4.3 are retired**; 4.2 and 4.4 survive as the whole of MVP-4.

**Why.** 4.1 was presence in the canvas and spreadsheet bodies on top of the presence that already
ships for text; 4.3 was cards on a canvas referencing items. Both are refinements of collaboration
rather than the thing itself, and the thing itself works.

**What it costs, stated plainly.** Two people editing the same canvas or spreadsheet see each other's
carets and nothing finer. A canvas cannot embed an item; it holds its own content.

### The plugin platform. Retired 2026-08-14. *(was MVP-9)*

It was a QuickJS-in-WebAssembly sandbox, a capability API, closed extension points, install and
lifecycle, per-plugin storage and settings, a host-brokered network, a background host, a published
plugin API and a stability policy. **Goals 9.1-9.11 are retired**, `docs/nix-plugin-architecture.md`
and `docs/plugin.md` are deleted, and the unmerged sandbox work on `goal/Q1-plugin-runtime-and-host`
was deleted with them.

**Why.** The phase existed because four wanted features were specified as plugins. None of them
needed it: the PDF and DOCX converters already ship as `@nix/pdf-export` and `@nix/docx-export`
registered in the media service, which is now where they belong rather than a way-station; the
calendar integration is 11.3, written directly; and the Obsidian sync and the MCP server are dropped
(below). A platform whose every consumer turned out not to need it is a platform built on a bet.

**What it costs, stated plainly.** Nobody outside this repository can add a capability to Nix, and
there is no in-process boundary between feature code and the rest of Core — the sandbox was also a
containment story, and first-party features have only review and the test suite between them and the
data. For a self-hosted workspace serving a trusted team of about ten, where every author is a
contributor here, a sandbox contains code that was already trusted, and its price is a runtime, a
bridge, a manifest, a permission screen and a stability policy maintained forever.

**The security rules it carried do not lapse with it.** Untrusted bytes still parse in isolation in
the media service (7.6's gate), and the egress-proxy rule still binds (§12).

### Obsidian sync. Retired 2026-08-14. *(was 11.4)*

A Nix subtree synchronised against an Obsidian vault over Markdown. Dropped on the owner's decision:
it is a second product's data model kept permanently in step with this one, and its conflict
handling is a standing cost with no ceiling. **What remains of the intent** is 7.2 and 7.3 — Markdown
out and Markdown in — which let somebody move work between Nix and a vault deliberately rather than
continuously.

### The MCP server. Retired 2026-08-14, **reinstated 2026-08-15**. *(was 9.10, now 9.3)*

Retired with the plugin platform on the reasoning that it was a plugin and the platform was gone.
That reasoning does not survive the platform's absence: an MCP server is an API client, not
sandboxed code, so it needs no runtime, no capability broker and no manifest. It is back as 9.3,
built as first-party code on the same authorization path as every other surface, and it keeps the
property that made it worth having — it is the proof that the model holds when the caller is a
program rather than a person.

## 13. What is deliberately not planned

Recorded so they are not re-proposed as oversights. Each was decided against for this product's
shape — a self-hosted workspace for a trusted team of about ten — and each becomes a live question
again if that shape changes.

- **An extension platform of any kind**, and with it a marketplace, third-party authors, reviews and
  updates — a runtime that executes code somebody installed. §12 records the whole phase being
  retired, not merely the marketplace on top of it. **MVP-9's MCP server and CLI are not this**: they
  are clients of the API with no runtime, no sandbox and no manifest, holding no more than the
  principal they act for. That distinction is the whole reason MCP could come back while the platform
  stayed retired.
- **Anything that reaches another service.** No calendar sync, no OAuth, no ICS feed, no connected
  accounts of any kind. Added 2026-08-15 with the scope closure: dates live in Nix and are read in
  Nix. The egress-proxy rule and the credential rule both survive with no consumer, because they cost
  nothing unused and are what a future integration would have to satisfy first.
- **Files, attachments and object storage** — see §12. The single largest thing this product does not
  do.
- **Full ACL precedence, deny entries, inheritance breaks and an audit pipeline.** Built for a
  workspace whose members the owner does not personally know. MVP-8's member/admin roles are what this
  size needs.
- **Public workspace or item sharing**: anonymous readers, public sites with custom domains, a
  separate-origin document reader and an image proxy. Published Interactive Forms are the narrow
  exception: an opaque link exposes sanitized form content and accepts child-item submissions, but
  never exposes the workspace, companion views or existing responses.
- **Collaboration at 100+ concurrent editors on one document**: load harnesses, non-quadratic
  awareness fan-out, sharding with sticky routing and handover. A ten-person team is never all in one
  document.
- ~~A second and third calendar provider.~~ Superseded 2026-08-15: there is no first one. Folded
  into "anything that reaches another service" above.
- **A second, row-and-column spreadsheet engine with its own dependency graph and incremental
  recalculation.** The engine that ships is real formula work and stays as it is; with MVP-2
  retired, nothing else was going to reuse it anyway.
- **Native mobile.** The responsive web application reaches a phone; a native client multiplies the
  cost of every later interface change.
- **Pen input on canvas**: pressure, tilt, palm rejection. Serves a stylus workflow this team does not
  have.
- **Habit tracking and pomodoro timers, email as a first-class object, real-time voice or video, and a
  theme marketplace.** The first two do not compose with a document workspace, the third is a
  different product with a different operational burden, and a theme that can move a ramp step can
  break contrast — which is not negotiable.

---

## 14. The standing gates

Every phase is subject to these, and a phase does not exit having broken one.

**Stability.** No phase exits carrying a defect it created, and no phase begins while §2.4's
"asserted" list still has entries. This is the gate the 2026-08-14 refocus added, and it is what
makes stability a property of every phase rather than the name of one.

**Performance.** The budgets in §1, plus each phase's own performance row, measured with numbers
committed to the repository rather than quoted in a pull-request comment.

**Security.** One authorization code path; fail closed with a test asserting the no; secrets have one
shape (encrypted at rest with a managed key, never in a URL, a log or an error message); every
server-side fetch of a user-supplied address goes through an egress proxy with internal ranges
refused; untrusted bytes parse in isolation, never in Core's process; the supply chain is part of the
surface (audited lockfiles, a pinned toolchain, and the one large deliberate trust decision —
Excalidraw — version-pinned and upgraded on purpose).

**Phase gates that block an exit outright:**

| Phase | Gate |
|---|---|
| MVP-7 | The hostile-import corpus — zip bomb, entity expansion, oversized, malformed — refused in CI |
| MVP-8 | Every admin-only write proven admin-only by a test asserting the no, and revocation shown to close a live socket |

**Process.** One goal is one commit, with the tests, lint and build green before it is made. Reviews
by domain — user experience, developer experience, performance — before every commit; [SEC] goals
additionally need owner approval before merge. MVP-0 contains six goals that skipped that step, and
5.1 and 5.2 are the debt that created.

---

## Appendix A — Where the detail lives

- `CLAUDE.md` — the standards every contributor works to: commands, architecture rules, memory rules,
  style, testing layout, commit rules.
- `docs/nix-development-document.md` — what the product is, feature by feature.
- `docs/nix-engineering-plan.md` — how it is built.
- `docs/adr/` — the decisions, numbered. Note that 0033 to 0036 do not exist and ADR-0035 is cited by
  shipped code; that gap wants closing before more numbers are minted.
- `docs/nix-mvp-plan.md` — the previous plan document. **Superseded by this one for sequencing**, and
  worth keeping for its history: why phases were cut, renumbered and rescoped, and what each shipped
  goal cost to build. It describes the plugin platform and the file model as live work; both are
  retired, and §12 here is what supersedes it on those.

## Appendix B — Coordinates, old and new

**Two mappings, because there have been two renumberings.** The first maps the letter-series labels
(`N`, `S`, `U`, `K`, `L`, `C`, `E`, `Q`, `T`, `W`, `P`, `I`, `F`, `D`) that older ADRs and commit
messages use. The second maps the MVP numbers as they stood between 2026-08-14 and 2026-08-15, which
the **2026-08-15 renumbering changed** — the sequence now reads in priority order, so almost every
phase moved. Both are informative: they exist so an older reference can be followed forward.

### B.1 — MVP numbers before and after 2026-08-15

| Was | Is now | |
|---|---|---|
| MVP-0 | MVP-0 | unchanged |
| MVP-6 — templates | **MVP-1** | reinstated and promoted to first |
| MVP-10 — computed properties | **MVP-2** | reinstated |
| MVP-5 — running your week | **MVP-3** | reinstated |
| MVP-8 — a live workspace with a memory | **MVP-4** | the memory half only; 8.2 is now 4.2 and 8.4 is now 4.4 |
| MVP-1 — a workspace you can trust | **MVP-5** | goals 1.1-1.16 are now 5.1-5.16 |
| MVP-3 — a workspace you can operate | **MVP-6** | goals 3.1-3.6 are now 6.1-6.6 |
| MVP-4 — bring your work into | **MVP-7** | goals 4.1-4.7 are now 7.1-7.7 |
| MVP-7 — workspaces and who is in them | **MVP-8** | goals 7.1-7.9 are now 8.1-8.9 |
| 9.10 — the MCP server | **9.3**, inside the new MVP-9 | retired 2026-08-14, reinstated 2026-08-15 |
| MVP-2 — files | retired | §12, by name |
| MVP-9 — the plugin platform | retired | §12, by name |
| MVP-11 — the calendar integration | retired | §12, by name |
| 8.1, 8.3 — presence remainder, canvas embeds | retired | §12, by name |

**Only the phase digit moved.** Sub-numbers were preserved deliberately, so a reference like "1.8's
fix" becomes "5.8's fix" and nothing inside a phase needs rereading.

**Coordinates completed after that mapping:** 1.6 (Spreadsheet view) is delivered and recorded under
MVP-1 rather than left in its active table. The older 1.7 form proposal is no longer a retired idea:
Quick Form and Interactive Form now ship, including guided setup, composed response views and an
optional public submission link. It is baseline work and does not create a new active coordinate.

### B.2 — Letter-series labels

| Old | New |
|---|---|
| N1-N11, S1-S11, U1-U14, K1-K20, L1-L6, C1-C4, E0, E2, E3, E4 | MVP-0 (built) |
| K21 and the unreviewed [SEC] surface | 5.1, 5.2 |
| L9 | 5.7 |
| The old plan's MVP-9 files half | Files — **retired**, §12 |
| B2 (observability, which never had a phase) | 6.4 |
| E1, E5-E10 | MVP-7 (import) |
| W1-W10 | MVP-3 (running your week) |
| T1-T3, T4-T8 | MVP-1 (templates) |
| P1-P3, C7 | MVP-8 (workspaces and who is in them) |
| C5 remainder, C6, L7 | C6 (history) is MVP-4; the presence and canvas-embed rows **retired**, §12 |
| Q1-Q10 | The plugin platform — **retired**, §12 |
| F1, F2, F6 | MVP-2 (computed properties) |
| I1, I2, I5, I6, I7 | The calendar integration — **retired**, §12. I-series Obsidian **retired**; the MCP entry is **reinstated** as 9.3 |
