# Architecture and security guide

Read this for cross-cutting work and all auth, permission, RLS, token,
`/internal`, migration, or data-boundary changes.

Nix has one structural item kind. Body type is open and draws an item's body;
views are a closed, server-validated child-rendering set. Core alone evaluates
permissions; clients never do. Search is derived, Postgres remains authoritative,
and file bytes bypass Core via presigned capabilities.

The browser is a Core-owned BFF: Core validates issuer/UserInfo under the bounded
JIT policy, creates HttpOnly sessions, and issues short-lived Nix access tokens.
External identity is `(tenant_id, issuer, subject)`. Roles are database data, not
claims. Auth boundary changes require security review and owner approval before
merge; OpenAPI breaking changes also require the appropriate label and ADR.

For a new interface, provide two real implementations, an I/O fake, or a
documented swap plan. Never make a surprising architecture decision implicitly:
surface it for an ADR first.
