# Backend guide

Read for changes under `backend/`, `Nix.slnx`, or `Nix.Frontend/`.

Use minimal API endpoint groups only. Preserve the folder dependency direction:
`Domain -> Abstractions -> Persistence -> Features`; Domain has no infrastructure.
Use CQRS messages with explicitly registered handlers, typed IDs, sealed records,
`Result` for expected failures, and RFC 9457 problem details. Default EF queries to
`AsNoTracking`; authorization must happen during query evaluation.

Route families are security boundaries: `/api/v1` has unit-of-work tenant context,
`/auth` is the browser BFF boundary, and `/internal` is service-authenticated. Do
not move a route without proving its new boundary. Keep RLS context `SET LOCAL`.

Stream first. Follow the memory order in the legacy standards; annotate forced
`byte[]` allocations. For new hot SQL, capture a realistic `EXPLAIN (ANALYZE,
BUFFERS)` plan. A documented index is not proof it is used.

Run the mapped unit checks. Persistence, RLS, permission, migration, or SQL work
also needs integration proof against real Postgres. A backend build regenerates
the OpenAPI contract; regenerate the API client whenever that contract changes.
