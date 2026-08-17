# ADR-0041 — Workspace templates are hidden, versioned item trees

**Status:** accepted · **Date:** 2026-08-16 · **Phase:** MVP-1 (T1–T5)

## Context

The shipped template registry could create three client-known configurations, but it could not
capture a team's schema, views, content, or children. Its schema and view writes were separate, and
renaming an applied component defeated idempotency. File-managed templates need the same behavior
as authored ones without giving deployment code database access.

## Decision

Templates are ordinary item subtrees behind a `workspace_template` catalog. Template items carry a
stable source ID and an internal lifecycle, and ordinary item reads exclude them from navigation,
search, graph, calendar, bookmarks, queries, and public forms. Seeded Kanban, Calendar, and List
entries use this catalog; the web client owns no preset registry.

Every capture, import, edit, and application is staged. Core authorizes and allocates hidden
envelopes, Collab copies bodies and remaps internal references, and one Core transaction activates
the exact staged set. An incomplete or expired operation never exposes its items. Editing clones an
active revision into a draft; Save swaps the catalog root atomically and Discard removes the draft.

Application preflight rejects field-type conflicts, identifier collisions, and invalid view
dependencies before mutation. Stable source-to-target mappings make reapplication append only new
compatible fields, views, and descendants. Existing body, root values, views, and user edits win.
ACLs, public links, publication state, and service identities are never copied.

Authored templates are workspace-visible: readers can browse and export; editors can capture,
import, edit, apply, and delete. Managed templates are read-only and reconciled by stable key from a
post-health deployment Job. That Job uses a short-lived OIDC JWT-profile token for one pre-provisioned
editor principal and sends untrusted `.nix` bytes only to Media.

## Consequences

- Template operations need one schema migration, tenant-scoped RLS, audit records, expiry cleanup,
  and retry-safe source mappings.
- The template library and New menu are API-driven. Templates do not appear as suggestions in the
  Views panel.
- General workspace import remains later work; MVP-1 exposes archive reading and remapping only
  through template workflows.
- The parser, internal orchestration, migration, and machine identity are security-sensitive and
  require owner approval before merge.
