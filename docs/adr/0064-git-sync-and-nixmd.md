# ADR-0064: Git sync and the .nixmd text format

## Status

Deferred, 11 October 2026. The owner removed git sync and the `.nixmd` format from the Nix sites scope. Nix Docs content lives in Nix only. The partly built `@nix/nixmd` package is parked outside the repository at `../nix-lanes/parked/nixmd-2026-10-11` and can be revived with this record. The decisions below are kept for that revival.

Proposed, 11 October 2026. The owner wants documentation to live both in the repository and in Nix, kept in sync, with detailed styling preserved. These are the decisions:

- Git sync is a general feature for any subtree. Version 1 supports GitHub only.
- Repositories hold `.nixmd` text files, one per item. `.nixmd` is a lossless, Nix-flavoured Markdown.
- Inside Nix, Yjs stays the source of truth, and nothing is stored as Markdown.
- The folder layout mirrors the item tree.
- Nix writes to git through pull requests.
- Changes reach Nix from git through a GitHub App webhook.
- An item that changed on both sides pauses as a conflict.

This record needs a [SEC] review before implementation. GitHub App credentials, a public webhook endpoint, and writes into workspaces made on behalf of an external system all cross trust boundaries.

## Context

Markdown loses information in both directions:

- **Export** drops underline, colour, highlight, alignment, merged table cells, columns, toggles and embedded items, and writes no frontmatter.
- **Import** turns toggles into plain text and always creates new items.

The `.nix` archive is lossless, but it is a zip file. It cannot be diffed or edited in a pull request, and import does not update existing items.

Nothing in Nix talks to git today. An external body write applies a minimal Yjs diff. It has no base check, so concurrent live edits interleave with it.

## Decision

### The .nixmd format

`.nixmd` is a versioned text format. Each file starts with frontmatter that declares:

- `format: nixmd/1`;
- the item `id`;
- the title;
- the order among siblings;
- the body kind;
- property values, typed.

The body is CommonMark with GFM tables and strikethrough, plus three extensions:

- **Inline attributes**, in the style of Pandoc and Djot. Underline, colour, highlight and similar marks are written as `[text]{.underline color=accent bg=yellow}`. Colours are stored as theme tokens, and as hex only when the source used hex.
- **Block attributes**, written on the line before a block, such as `{align=center}`.
- **Directive blocks** for structure that Markdown cannot express: `:::callout{tone=note}`, `:::toggle`, `:::columns`, and `:::table` for tables with merged cells, widths or styled cells.

Nodes with no readable form use a fenced `nix-node` JSON block. Item links and references use `nix://` URIs.

The format belongs to one shared TypeScript package. Git sync, the site builder, `nixctl` import and export, and the web app all use it. A golden suite proves that Nix to `.nixmd` to Nix is exact for every node and mark in the editor schema, and it is a CI gate. A change that is not round-trip safe needs a new format version.

`.nixmd` is only a boundary format. The `.nix` zip archive remains a separate format for complete workspace portability.

### Layout

The repository folder mirrors the item tree:

- An item with children is a folder containing `index.nixmd`.
- A leaf item is `<slug>.nixmd`.
- File bytes go in a sibling `_files/` folder, tracked with Git LFS.

Identity comes from the frontmatter `id`, not the path:

- Moving or renaming a file is a move in Nix.
- A file without an id creates an item, and the sync writes the id back.
- A file that is deleted from git moves its item to the trash. It is never purged.

### Sync

A sync binding connects one subtree to a repository, a branch and a folder. Only a workspace manager can create one. For each item, the binding records the last synced commit, the last synced content snapshot and a content hash.

**Git to Nix.** A GitHub App webhook, signed with HMAC and delivered through the public tunnel, reports pushes to the tracked branch. Core verifies the signature and the delivery id, then queues a sync job. For each item, the job compares the incoming content hash with the recorded base:

- If only git changed, the job applies the new content as a Yjs diff, but only if the Nix snapshot still equals the base snapshot, checked at write time. This adds a base precondition to external body writes.
- If both sides changed, the item pauses as a conflict.

**Nix to git.** Confirmed changes inside the subtree are batched, with a debounce, onto a `nix-sync/<subtree>` branch. The sync then opens or updates a single pull request. It never pushes to the tracked branch. Merging the pull request completes the round trip through the webhook.

**Conflicts.** A conflicted item shows both versions in Nix. A manager resolves it by choosing one side, or by merging in the editor. The resolution becomes the new base.

**Identity of writes.** Writes into Nix run as a dedicated sync principal for each binding. It has Editor membership limited to that workspace, and every write is audited with the commit author and the commit SHA. GitHub App private keys and webhook secrets are operator secrets held by Core.

## Consequences

Docs can be reviewed and edited on GitHub with their styling intact. Yjs stays the source of truth, and git becomes a reviewed mirror.

Round-trip correctness is the core risk. The golden suite and format versioning are mandatory, and any schema node added later must define its `.nixmd` form before it ships.

The sync principal can edit content within its binding. A compromised GitHub App key or webhook secret could therefore write into a synced subtree, but nowhere else. Trash-only deletion and audit records limit the damage.

The external body-write path gains a base check. Clients that expect blind merging must handle a conflict response.

Git LFS becomes a requirement for repositories that sync files.

## Verification required before release

- The golden round trip passes for every editor node and mark, every property type, and every directive.
- A fixture repository synced with a fixture subtree passes each of these checks:
  - an edit in git appears in Nix;
  - an edit in Nix appears as a pull request;
  - an edit on both sides pauses the item as a conflict;
  - a rename in git moves the item;
  - a deletion in git moves the item to the trash;
  - a new file without an id creates an item and receives an id.
- A replayed or unsigned webhook is refused, and a forged delivery id is refused.
- The sync principal cannot read or write outside its subtree.
- Locked items are never exported to git.
