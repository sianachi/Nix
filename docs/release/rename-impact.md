# Rename impact audit

An inventory of every place the current name is load-bearing, grouped by whether a rename may touch
it. Compiled 13 October 2026 from the source tree.

## Display only (safe to rename in one release)

- Web manifest `name`/`short_name` and the HTML `<title>` (`apps/web/public/manifest.webmanifest`,
  `apps/web/index.html`); icons `apps/web/public/nix-icon*`.
- UI copy that says "Nix" ("Syncing notes with Nix", settings prose), the MCP server identity
  (`nixctl`, in `apps/cli/src/mcp.ts`) and CLI help text.
- Repository and documentation site titles.

## Identifiers people type (rename needs a compatibility window)

- The CLI binary `nixctl` and its config directory `$XDG_CONFIG_HOME/nixctl/`; MCP client
  configurations reference `nixctl mcp`. Ship the new binary with a `nixctl` shim for one minor
  series.
- Compose service and image names (`nix-api`, `ghcr.io/sianachi/nix/*`), Kubernetes namespace `nix`
  and resource names, Caddy upstreams. Renaming is a redeploy, not a migration; keep for v0.1.

## Persistent formats and keys (do not rename casually)

- `.nix` archive/export suffix, read by import, export and the docs catalog; a rename needs a dual
  reader and a deprecation period.
- Browser storage prefixes `nix.`/`nix-`, window events `nix:`, PWA cache names `nix-pwa-*`,
  IndexedDB `nix-offline-notes`, body cache keys: renaming loses every device's local state unless
  migrated.
- Database names, roles (`nix_app`, `nix_migrator`) and the `Nix:*` configuration section names:
  operational, out of scope for a product rename.
- Package names `@nix/*` and the Go module path: internal; rename only with the monorepo refactor.

## Decision for v0.1

Ship v0.1 under the current identity. If the owner adopts a new name, rename display surfaces and
the binary (with shim) in 0.2 and leave formats, keys and infrastructure names alone.
