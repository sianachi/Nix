# Local setup and sign-in

From the repository root, run `mise install`, `pnpm install --frozen-lockfile`, then
`bash scripts/dev-stack-up.sh`. Docker must be available. Stack-up starts core/search infrastructure,
creates the private object bucket, seeds database roles, runs the migrator, configures Zitadel and
seeds application data. It does not start the four host application processes.

Local PDF import also needs `pdftotext` on the worker PATH (provided by Poppler); the worker
Dockerfile installs `poppler-utils`, but mise does not install it for host development.

Start `scripts/dev-api.sh`, `scripts/dev-collab.sh`, `scripts/dev-worker.sh`, and
`pnpm --filter @nix/web dev` in separate terminals. Use <http://localhost:5173>.
The default development user is `dev@nix.localhost`, password `NixDev-Password1!`.
Overrides and previously initialized volumes can change these defaults.

Zitadel setup writes machine-specific OIDC configuration under `deploy/.zitadel/`.
API and Collaboration scripts consume `oidc.generated.env`. Rerun stack-up if it is missing;
do not invent or copy another machine's client/project IDs. The API script creates a local signing
key when absent and configures persistent BFF data-protection keys. These files are secrets.

Core owns the browser OIDC/PKCE flow and HttpOnly session. Browser tokens do not carry workspace
roles. See [ADR-0045](adr/0045-personal-workspaces-and-opt-in-jit.md) for identity and personal
workspace policy. Inspect the seed SQL for current tenant IDs rather than hard-coding them here.

For migration-only work, `bash scripts/dev-migrate.sh` uses the local migrator role.
For custom connections, run `dotnet run --project backend/src/Nix.Migrator` with
`NIX_MIGRATOR_CONNECTION_STRING` set explicitly. Do not use the migrator role for the application.

If sign-in fails, check that stack-up completed, the generated OIDC file exists, and the API was
started with `dev-api.sh`. Keep the localhost origins and configured ports consistent across Core,
Zitadel, web and Collaboration. Query application data only through `nixctl` or MCP.
