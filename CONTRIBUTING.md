# Contributing to Nix

Nix is a self-hosted workspace for notes, tasks, habits, files, calendar and numbers, all kept in one item tree. The [README](README.md) describes what it does.

## Where to start

Pick an issue labelled [`good first issue`](https://github.com/sianachi/nixsites/labels/good%20first%20issue) or [`help wanted`](https://github.com/sianachi/nixsites/labels/help%20wanted). Comment on it to say you are taking it, so two people do not build the same thing. If an issue has had no activity for a few weeks, ask before you start.

For anything larger than a small fix, open or comment on an issue first and agree on the approach before you write code.

## Run it locally

You need [Docker](https://docs.docker.com/get-docker/) and [mise](https://mise.jdx.dev/).

```sh
git clone https://github.com/sianachi/nixsites.git && cd nixsites
mise install                       # Node 22, pnpm 10, .NET 10 and Go 1.26
pnpm install --frozen-lockfile
pnpm dev                           # infrastructure, database, identity, then every service
```

Open <http://localhost:5173> and sign in as `dev@nix.localhost` with `NixDev-Password1!`. These are local development credentials only.

`pnpm dev` is safe to re-run. `bash scripts/dev.sh --help` shows how to start only some services. Ports can be overridden; see `.env.example`.

## Check your change

Run these from the repository root.

```sh
./scripts/changed-path-checks.sh --working-tree    # prints the checks your diff needs
./scripts/validate-changed.sh --working-tree       # runs them
```

Use `./scripts/validate-changed.sh --dry-run --working-tree` to see the exact commands first. After you commit, `--base main` compares your branch to `main` instead of the working tree.

CI is the merge authority. These scripts select the smallest useful set, so a broad change may need more.

Common commands are listed in [docs/development.md](docs/development.md):

```sh
pnpm lint
pnpm typecheck
pnpm --filter @nix/web test
dotnet test backend/tests/Nix.Tests/Nix.Tests.csproj
go -C apps/go-workers test ./...
```

The backend integration tests need Docker. If you cannot run a check, say so in the PR.

## Rules that are easy to break

- **One kind of item.** The body type (note, canvas, spreadsheet) never controls structure. Views render children.
- **Core is the only permission authority.** Filter in queries, keep the row-level security context `SET LOCAL`, and never put roles or authorization decisions in browser tokens.
- **Generated files stay generated.** Never hand-edit `backend/openapi/nix-api.json` or the API client. Regenerate them:

  ```sh
  dotnet build backend/src/Nix.Api/Nix.Api.csproj -p:NixGenerateOpenApiContract=true
  pnpm --filter @nix/api-client generate
  ```

  Commit both outputs together with the change that caused them.
- **No emojis** in code, comments, tests, docs, logs, UI text or commit messages.
- **Migrations** go through `backend/src/Nix.Migrator`. Say in your PR what the migration does and how it was tested.
- **Frontend guards.** Raw design values, layering, text primitives and spacing roles are checked by scripts. `./scripts/changed-path-checks.sh` selects them when they apply.

Deeper rules by area live in [`docs/agent-guides/`](docs/agent-guides/):

- [`backend.md`](docs/agent-guides/backend.md)
- [`frontend.md`](docs/agent-guides/frontend.md)
- [`workers.md`](docs/agent-guides/workers.md)
- [`architecture-and-security.md`](docs/agent-guides/architecture-and-security.md)
- [`workflow-and-validation.md`](docs/agent-guides/workflow-and-validation.md)

Read the one that matches the code you change. [AGENTS.md](AGENTS.md) maps paths to guides.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`, lower case, no full stop, imperative mood. Types in use are `feat`, `fix`, `docs`, `test`, `chore` and `ci`. The scope names the area.

```
fix(files): detect MP4 and WebM videos so sites can publish them
test(web): wait for the workspace rows before using the group menus
docs(readme): describe Nix Sites, video attachments and approver management
```

One change per commit. Stage explicit paths (`git add path/to/file`), not `git add .` or `git add -A`.

## Pull requests

1. Fork the repository and branch from `main`. Do not push to `main`.
2. Keep the PR to one focused change. Unrelated cleanups go in their own PR.
3. Link the issue (`Closes #123`).
4. Fill in the PR template: what changed, what you ran, and what you could not run.
5. Wait for CI. Fix failures instead of re-running until they pass.

If users will notice the change, add a line to `CHANGELOG.md` under `## Unreleased` (add the heading if it is missing).

## Hacktoberfest

The repository carries the `hacktoberfest` topic. A pull request counts when a maintainer merges it or labels it `hacktoberfest-accepted`. Pick a listed issue and follow the steps above. Pull requests that only reformat, rename or repeat existing work will be closed.

## Reporting bugs and proposing features

Use the issue forms: [new issue](https://github.com/sianachi/nixsites/issues/new/choose). A good bug report has steps that reproduce it, the version or commit, and where you run Nix (local dev, Compose or Kubernetes). Remove secrets, tokens and personal data from logs before you paste them.

Do not report security problems in public issues. See [SECURITY.md](SECURITY.md).

## Licence

Nix is released under the [MIT licence](LICENSE). By contributing, you agree that your contribution is licensed the same way.
