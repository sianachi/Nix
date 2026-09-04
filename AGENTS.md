# Nix contributor routing

Read this file first. It is the short, always-applicable contract; before acting,
read every guide named by the path you will change. Guides are local standards
material and live in `docs/agent-guides/`.

## Always

- Product direction is in `README.md`; accepted architecture is in `docs/adr/`.
  Reconcile a task with the tree and recent commits. Observed shipped behaviour
  wins; stop and surface an architectural surprise that needs an ADR.
- Before editing, create an isolated worktree with
  `scripts/new-goal-worktree.sh <feature-slug> [base-ref]` when the current tree
  has unrelated changes or the task needs more than one commit. Make one focused
  task at a time; preserve unrelated changes in a shared tree.
- Do not assert unobserved results. Run the checks selected by
  `scripts/changed-path-checks.sh` and report anything that cannot run.
- Query or stress a running Nix instance through `nixctl` or MCP. If neither can
  express the need, close that tooling gap in the same session.
- No emojis in code, comments, tests, docs, logs, UI copy, or commit messages.
- Do not commit local standards or Markdown unless the owner explicitly asks.
  Stage explicit paths only; never use `git add .`, `git add -A`, or `git commit -a`.

## Read by change area

| Change area | Required guide |
| --- | --- |
| `backend/**`, `Nix.slnx`, `Nix.Frontend/**` | `backend.md` |
| `apps/web/**`, `packages/**` | `frontend.md` |
| `apps/go-workers/**` | `workers.md` |
| Auth, RLS, permissions, migrations, `/internal`, tokens | `architecture-and-security.md` in addition to the area guide |
| CI, scripts, validation, commits, reviews | `workflow-and-validation.md` |
| Unsure or cross-cutting work | `architecture-and-security.md` and `workflow-and-validation.md` |

## Fast validation selection

Run `./scripts/changed-path-checks.sh --working-tree` before validation, or pass
changed paths explicitly. It prints the smallest relevant local check set and
the cases that require broader proof. It does not replace CI or judgment.

## Core invariants

- There is one kind of item: body type never controls structure; views render
  children and canvas is a body kind.
- Core is the sole permission authority. Filter during queries, keep RLS context
  `SET LOCAL`, and never put roles or authorization decisions in browser tokens.
- Browser auth is Core's BFF flow. Files use capability URLs, never Core bytes.
- Durable data is authoritative; closure, snapshots, search, links and
  embeddings are rebuildable derived state.
- OpenAPI is a contract seam: explicitly generated `backend/openapi/nix-api.json`
  and generated API-client code are never hand-edited.

The previous complete policy is retained at
`docs/agent-guides/legacy-full-standards.md` during this transition. Prefer the
focused guides above; use the legacy file only to resolve a rule not yet routed.
