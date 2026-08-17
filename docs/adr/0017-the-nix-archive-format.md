# ADR-0017 — The `.nix` archive format

**Status:** accepted · **Date:** 2026-07-29 · **Phase:** MVP-6.5 (E2, E6), amended MVP-1

## Context

`.nix` is E2's lossless native format: "document, properties, views, children and attachments in one
archive." E6 is its exact inverse, round-trip tested. Together they are the honest test of whether the
document model is complete — the plan says so outright, and it is the reason export comes before
import.

That makes the archive a **public contract**, in the same class as `backend/openapi/nix-api.json`.
Once one file exists outside this repository, its shape is something we have to keep reading. Every
decision below is unfixable after the first export ships, which is why they are settled here rather
than discovered during implementation.

Four properties of the current model constrain the format, and each was verified against the code
rather than assumed:

- **Sibling order is data.** `ItemResponse.Seq` is documented as "its position among its siblings",
  and list, board and gallery all render in it. It is not derivable from anything else in an archive.
- **The property schema cascades past any subtree boundary.** `GetEffectiveSchemaHandler` merges every
  ancestor's declaration, and its own remarks say the result is "not something a client can compute
  because it cannot see the ancestors." A subtree rooted below a declaring ancestor therefore inherits
  columns from outside whatever we put in the archive.
- **Every read is permission-filtered.** A subtree export cannot see what the caller cannot see, so an
  archive may be missing branches that exist.
- **The body is versioned.** `SCHEMA_VERSION` is 1 today and is a deliberate, reviewed bump. An archive
  read after a bump has to know which version it was written against.

## Decision

> **Amended 2026-08-16 — template profile and bounded reader.** Archive v1 gains an optional
> `profile` object with `kind: "template"`, profile version 1, portable key, name, description, and
> body/children capture flags. Its absence still means an ordinary v1 archive, which template
> endpoints refuse without making older files invalid. View payloads gain additive optional
> filters, companion fields, placement, and complete Interactive Form configuration; absent fields
> default to null or empty.
>
> Media is the only process that parses incoming archive bytes. Its streaming reader requires the
> manifest first and exact manifest/entry correspondence; rejects unsafe or duplicate paths; and
> limits an archive to 200 items, depth 32, 64 MiB expanded, 8 MiB per entry, a 100:1 expansion
> ratio, and 30 seconds. Core and the browser receive validated values, never zip bytes.

### 1. The archive holds *n* items, from the first commit

A `.nix` file is a zip containing a manifest and one payload entry per item. **A single-document export
is the degenerate case with one entry, not a different format.**

```
manifest.json               first entry, always
items/<sourceId>.json       one per exported item
attachments/<sourceId>/     MVP-6; absent until files exist
```

The manifest is written first so a streaming reader has the structure before the payloads — E9 needs a
10k-note archive to be readable without holding it in memory, and a reader that must seek to the
central directory before it knows what it is holding cannot stream.

```jsonc
{
  "format": "nix-archive",
  "formatVersion": 1,
  "schemaVersion": 1,              // editor-schema SCHEMA_VERSION at export
  "exportedAt": "2026-07-29T...",  // Instant, zone-qualified per ADR-0012
  "root": "<sourceId>",
  "rootEffectiveSchema": { ... },  // see 3
  "items": [
    { "id": "<sourceId>", "parentId": "<sourceId>|null", "seq": 4, "title": "...", "type": "note" }
  ],
  "omitted": [ ... ],              // see 4
  "loss": [ ... ]                  // LossReport, empty for a complete .nix
}
```

`items` is the ordered spine: parentage and `seq` live here, not in the payloads, so a reader can
reconstruct the tree without opening a single body. A payload carries the item's own body
(ProseMirror JSON), its declared schema, its views, and its property values.

### 2. Import mints new identifiers by default; preserving them is a separate, refusing operation

**Default — copy.** Import allocates fresh `ItemId`s and maintains a `sourceId -> newId` remap for the
whole archive. Every link whose target is inside the archive is rewritten through the remap; every link
whose target is outside it becomes a stub, which is the behaviour MVP-3's L2 already defines for
unresolvable targets. The remap is written into E8's import report, so the mapping is inspectable
rather than internal.

**Opt-in — restore.** Preserving source identifiers is available, and it **refuses** if any identifier
in the archive already exists in the target tenant. It never overwrites.

The reasoning is that importing the same archive twice into one tenant is the ordinary case, not the
exceptional one — a teammate's export, a copy of a template subtree, a re-import after editing.
Preserving identifiers unconditionally makes the second import either a primary-key collision or a
silent destructive overwrite, and neither is a thing a person asked for by choosing "import".

This is also what forces `sourceId` into the archive at all: without it, a copy-mode import cannot
rewrite internal links, and every wiki link in an imported subtree would degrade to a stub.

### 3. The archive carries the effective schema at its root, marked inherited

`rootEffectiveSchema` is the merged ancestor result at the export root, with each property marked as
declared-here or inherited-from-above. Import re-declares only the inherited ones, onto the root, and
says so in the report.

Without this, a subtree exported from below a declaring ancestor imports as items holding property
values no schema declares — a shape the write path would reject on the next edit. That is silent loss
in the format whose entire job is not losing anything, and it is invisible in testing unless the
fixture deliberately roots the export below a declaration.

### 4. Losslessness is asserted, not assumed

The manifest carries `omitted` and `loss`. For a complete export both are empty, and *that emptiness is
the claim*. Where the export could not see something, it says so:

- A descendant the caller may not read appears in `omitted` with a reason, never as a silent gap.
- Soft-deleted descendants (N6) are excluded by default and recorded in `omitted`; a flag includes
  them, and the flag's setting is stated either way.

An archive with a hole in it and no comment is a lie about the one property this format sells.

### 5. `.nix` is untrusted input

A `.nix` file arriving for import is an attacker-supplied zip and is treated exactly as E10 treats a
DOCX: bounded memory, bounded time, bounded decompression ratio, entry-count and entry-name checks,
parsed inside the media service's no-credentials, no-egress boundary. Being our own format buys it
nothing — anyone can author one.

## Consequences

- **The single-document export you can ship first writes a real `.nix`.** Stage 1 emits `n = 1`.
  Stage 2's subtree export emits a longer `items` array and bumps nothing.
- **`formatVersion` is independent of `SCHEMA_VERSION`.** The archive's own shape and the document
  block set change for different reasons and on different cadences; one version field for both would
  force a fake bump on either side.
- **`attachments/` is reserved but unused.** Cover images are URLs until MVP-6 (U9 is deliberately a
  URL-level improvement), so a v1 archive carries no bytes. The directory is named now so its arrival
  is not a format change.
- **E6 gets the strongest test in the phase**: export a fixture subtree, import it into a second
  tenant, export again, compare. It is a property test, and it is what makes "lossless" a CI assertion
  rather than a claim in a README.
- **The remap table is shared machinery.** Copy-mode import, template application (T2) and any future
  duplicate-a-subtree operation all need the same "rewrite internal references through a mapping"
  step. It belongs in the shared export package, not in the import path alone.

## Alternatives considered

**A single JSON file rather than a zip.** Simpler, and adequate until attachments exist. Rejected
because the format is supposed to survive attachments arriving, and turning a JSON document into a
container later is exactly the format change this ADR exists to avoid. The cost of a zip with one
entry is negligible.

**Preserve identifiers by default, mint on collision.** Rejected: the fallback is invisible. A person
importing a copy would get preserved identifiers sometimes and fresh ones other times depending on
what already existed, which makes the resulting links non-deterministic. Choosing the mode explicitly
is worth the extra argument.

**Nest children inside their parent's payload, mirroring the tree.** Rejected: it makes a 10k-note
archive one deeply nested JSON document that cannot be streamed or partially read, and it puts
`parentId` and `seq` in two places — the nesting and the fields — which will disagree eventually.

**Carry only the schema declared at the root, not the effective one.** Cheaper, and it is what an
implementation writes if nobody thinks about the cascade. Rejected for the reason in section 3: it
loses ancestor-declared columns silently, and `GetEffectiveSchemaHandler` says outright that no client
can reconstruct them.

**Omit the `omitted` list and let the archive be whatever the caller could see.** Rejected: it makes a
permission-filtered export indistinguishable from a complete one, and the difference matters most
precisely when somebody is relying on the archive as their copy of the work.
