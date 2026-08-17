# ADR-0014 — Templates are shipped presets

**Status:** superseded by ADR-0041 · **Date:** 2026-07-27 · **Phase:** MVP-2.7

> **Superseded 2026-08-16.** MVP-1 replaces the client registry with workspace-authored,
> server-stored templates. Kanban, Calendar, and List now use that same catalog and operation path;
> no client-side fallback remains.

## Context

Setting up a Kanban by hand is four decisions before any value: declare a select property, add a
board view, choose what it groups by, make it the one that opens. Each is obvious only once you have
done it.

## Decision

**A client-side registry of three presets** — Kanban, Calendar, Checklist — written onto the item you
are on through the endpoints that already exist. `apps/web/src/views/templates.ts`, one entry per
template, the same shape as `view-kinds.tsx`.

> **Amended 2026-08-14, twice, neither amendment changing the decision.**
>
> **The third preset is now called "Task list".** "Checklist" is the name `nix-mvps.md` 5.6 gives a
> view *kind* — a real one, with its own renderer — and this preset makes a `list`. Two different
> things under one word, one of which was not what it said. Renamed while it was still free to
> rename: this ADR's own consequence is that a preset's id and label are client-side and never
> persisted, so nothing stored anywhere carried either.
>
> **The registry moved to `apps/web/src/views/core/templates.ts`.** The path above predates the
> `views/core/` split and no longer resolves.

**Schema first, then views.** `ContainerViews.cs` deliberately does not check that a view's grouping
property exists, so views-first stores a board that reports itself unrenderable until the schema
catches up — a broken thing on screen for no gain.

**Merged, never replacing.** Both writes replace wholesale, so a template sending only its own
properties would be a one-click way to delete somebody's schema. Folded into `schema.declared`, not
`schema.properties`, or inheritance quietly becomes a copy. What is already there wins, so applying
one twice changes nothing.

**The default is passed explicitly.** Omitted, the item still opens on its document and a one-click
"set up a board" appears to have done nothing.

## Consequences

- Four rules the server enforces are asserted against the templates themselves rather than
  discovered at runtime: every view's required property is one the template declares, every select
  ships at least one option, none claims the reserved `document` id, and each opens on a view it
  contains. Those are the four ways a template fails halfway, having already made the first write.
- **Not idempotent across a rename.** Matching is by property key and view id, so a template applied
  and then renamed by hand is applied again as a second entry.
- Offered only while an item has no views, since somebody who has built one does not want a row of
  buttons adding a second beside it.

## Alternatives considered

**User-creatable, stored templates.** Save any item's setup and apply it elsewhere. Needs a table, a
migration, a contract, a management surface, and an answer to what happens when a template changes
after being applied. Presets are a prerequisite of it either way, and they are what people actually
want first, which is to get started.
