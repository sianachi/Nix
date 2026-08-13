import { SCHEMA_VERSION } from '@nix/editor-schema';
import {
  ARCHIVE_FORMAT,
  ARCHIVE_FORMAT_VERSION,
  type ArchiveManifest,
  type ItemBundle,
  type Omission,
  type SchemaSnapshot,
  type ViewsSnapshot,
} from '@nix/export';

import {
  canvasStrategy,
  noteStrategy,
  sheetStrategy,
  strategyFor,
} from '../documents/body-kinds.ts';
import { findDocByItem } from '../db/documents.ts';
import type { ScopedQuery } from '../db/tenant-scope.ts';
import { loadDocument } from '../documents/service.ts';
import type { CoreClient, CoreItem } from '../core/client.ts';

/**
 * What one synchronous export may cost.
 *
 * **A request must not be able to walk an unbounded tree.** Every item costs two Core reads for its
 * schema and views plus a log replay for its body, so an export of everything would be a request
 * that holds a connection for minutes and a Core that spends the whole time answering it. The cap
 * is stated in the archive rather than silently applied: what was left out appears in `omitted`
 * with `limit-reached`, so a truncated export cannot be mistaken for a complete one.
 *
 * The fix when a workspace-sized export is wanted is MVP-6.5's E9 shape - a job, object storage and
 * a bulk read in Core - not a bigger number here.
 */
export const EXPORT_LIMITS = {
  maxItems: 200,
  maxDepth: 32,
  /** Concurrent Core reads while gathering schemas and views. */
  concurrency: 6,
} as const;

export type ExportScope = 'item' | 'subtree';

export interface ExportRequest {
  readonly token: string;
  readonly root: CoreItem;
  readonly scope: ExportScope;
  readonly includeDeleted: boolean;
}

export interface EnumeratedTree {
  readonly items: readonly CoreItem[];
  readonly omitted: readonly Omission[];
}

/**
 * Walks the subtree the caller asked for, parents before children, siblings in `seq` order.
 *
 * Pre-order because an import has to create a parent before the children that name it, and the
 * manifest's `items` array is what an import replays. Sorting is Core's - a listing already returns
 * siblings in position order - so nothing here re-derives it.
 *
 * **Soft-deleted children are listed and then excluded**, rather than never asked for. Asking Core
 * to hide them would leave this with no way to say they existed, and an archive that quietly omits
 * a branch is the failure ADR-0017 names outright.
 */
export async function enumerateSubtree(
  core: CoreClient,
  request: ExportRequest,
): Promise<EnumeratedTree> {
  const items: CoreItem[] = [request.root];
  const omitted: Omission[] = [];

  if (request.scope === 'item') {
    return { items, omitted };
  }

  // Recursive rather than a worklist, because the order has to be depth-first *in `items`*, not
  // merely in the order branches are visited. A queue appends a parent's whole child list at once,
  // which puts every uncle before the first grandchild - still importable, since parents precede
  // children either way, but it reads as scrambled to anybody opening the archive. Recursion depth
  // is bounded by `maxDepth`.
  async function visit(parent: CoreItem, depth: number): Promise<void> {
    if (!parent.hasChildren) {
      return;
    }

    if (depth >= EXPORT_LIMITS.maxDepth) {
      omitted.push({
        id: null,
        parentId: parent.id,
        reason: 'limit-reached',
        detail: `Descendants below depth ${String(EXPORT_LIMITS.maxDepth)} were not exported.`,
      });
      return;
    }

    const children = await listAllChildren(core, request.token, parent, omitted);

    for (const child of children) {
      if (child.lifecycleState !== 'active' && !request.includeDeleted) {
        omitted.push({
          id: child.id,
          parentId: parent.id,
          reason: 'soft-deleted',
          detail: `"${child.title}" is deleted and was not included.`,
        });
        continue;
      }

      if (items.length >= EXPORT_LIMITS.maxItems) {
        omitted.push({
          id: child.id,
          parentId: parent.id,
          reason: 'limit-reached',
          detail: `This export stops at ${String(EXPORT_LIMITS.maxItems)} items.`,
        });
        continue;
      }

      items.push(child);
      await visit(child, depth + 1);
    }
  }

  await visit(request.root, 0);

  return { items, omitted };
}

/** Every page of one item's children, or as many as could be read. */
async function listAllChildren(
  core: CoreClient,
  token: string,
  parent: CoreItem,
  omitted: Omission[],
): Promise<CoreItem[]> {
  const children: CoreItem[] = [];
  let cursor: string | null = null;

  for (;;) {
    const page = await core.listChildren(token, parent.workspaceId, parent.id, cursor);

    if (page === null) {
      omitted.push({
        id: null,
        parentId: parent.id,
        reason: 'not-readable',
        detail: 'The children of this item could not be listed.',
      });
      return children;
    }

    children.push(...page.items);
    cursor = page.nextCursor;

    if (cursor === null) {
      return children;
    }
  }
}

export interface GatheredMetadata {
  readonly schemas: ReadonlyMap<string, SchemaSnapshot | null>;
  readonly views: ReadonlyMap<string, ViewsSnapshot | null>;
}

/**
 * Reads every exported item's declared schema and view set.
 *
 * Held in full rather than streamed: this is small, bounded by {@link EXPORT_LIMITS}, and having it
 * up front is what lets the manifest be written before the first body. The bodies are the large
 * thing and they stay streamed.
 */
export async function gatherMetadata(
  core: CoreClient,
  token: string,
  items: readonly CoreItem[],
): Promise<GatheredMetadata> {
  const schemas = new Map<string, SchemaSnapshot | null>();
  const views = new Map<string, ViewsSnapshot | null>();

  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;

      const item = items[index];
      if (item === undefined) {
        return;
      }

      const [schema, viewSet] = await Promise.all([
        core.getSchema(token, item.id),
        core.getViews(token, item.id),
      ]);

      schemas.set(item.id, schema);
      views.set(item.id, viewSet);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(EXPORT_LIMITS.concurrency, items.length) }, () => worker()),
  );

  return { schemas, views };
}

export function buildManifest(input: {
  readonly root: CoreItem;
  readonly tree: EnumeratedTree;
  readonly metadata: GatheredMetadata;
  readonly includeDeleted: boolean;
  readonly exportedAt: Date;
}): ArchiveManifest {
  const { root, tree, metadata, includeDeleted, exportedAt } = input;

  return {
    format: ARCHIVE_FORMAT,
    formatVersion: ARCHIVE_FORMAT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: exportedAt.toISOString(),
    root: root.id,
    // The merged result at the root, not just what the root declares. The cascade reaches past the
    // export boundary, so without this an import lands items carrying values no schema declares.
    rootEffectiveSchema: metadata.schemas.get(root.id) ?? null,
    includesDeleted: includeDeleted,
    items: tree.items.map((item) => ({
      id: item.id,
      parentId: item.parentId,
      seq: item.seq,
      title: item.title,
      type: item.type,
    })),
    omitted: tree.omitted,
    // Empty, and that emptiness is the claim: `.nix` is the lossless format, so an entry here would
    // be a bug rather than a note.
    loss: [],
  };
}

/**
 * Produces one bundle per item, reading each body from the content log as it goes.
 *
 * One document is materialised at a time and released before the next, so the memory this costs is
 * one item's Yjs state rather than the whole export's.
 */
export async function* streamBundles(input: {
  readonly sql: ScopedQuery;
  readonly tenantId: string;
  readonly items: readonly CoreItem[];
  readonly metadata: GatheredMetadata;
}): AsyncGenerator<ItemBundle> {
  const { sql, tenantId, items, metadata } = input;

  for (const item of items) {
    yield {
      id: item.id,
      parentId: item.parentId,
      workspaceId: item.workspaceId,
      type: item.type,
      title: item.title,
      seq: item.seq,
      lifecycleState: item.lifecycleState,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      properties: item.properties,
      schema: metadata.schemas.get(item.id) ?? null,
      views: metadata.views.get(item.id) ?? null,
      body: await readBody(sql, tenantId, item),
    };
  }
}

/**
 * An item's document body, or null when it has never been opened.
 *
 * **Deliberately not `openDocument`.** That creates the row on first use, which is right for an
 * editor arriving to type and wrong for an export: a read must not write, and a note nobody has
 * opened has no body rather than an empty one.
 *
 * **Every body kind gets its own branch, and a missing one is a silent data loss rather than a
 * degraded render.** A canvas fell through to the prose branch until 2026-08-13: its ProseMirror
 * fragment is empty, so `materialize` returned null, so the bundle carried `body: null` - the same
 * answer as a note nobody had opened. The scene was absent from the archive that calls itself
 * lossless, with nothing anywhere saying so. That is why the dispatch below is exhaustive over the
 * strategies rather than "sheet, or else prose".
 */
async function readBody(
  sql: ScopedQuery,
  tenantId: string,
  item: CoreItem,
): Promise<ItemBundle['body']> {
  const doc = await findDocByItem(sql, tenantId, item.id);
  if (doc === null) {
    return null;
  }

  const state = await loadDocument(sql, tenantId, doc);

  try {
    // The item's type chooses how the body is read, on the same axis that
    // chooses its editor and the same one the collaboration service itself
    // dispatches on. A sheet read as prose would export an empty fragment
    // and quietly lose the grid.
    const strategy = strategyFor(item.type);

    if (strategy.kind === sheetStrategy.kind) {
      return { schemaVersion: doc.schema_version, sheet: sheetStrategy.materialize(state).json };
    }

    if (strategy.kind === canvasStrategy.kind) {
      // `materialize` returns `{ elements }` for an empty scene as readily as a full one, so
      // unlike prose there is no null to check: a canvas that exists has a body, even an empty one.
      return { schemaVersion: doc.schema_version, canvas: canvasStrategy.materialize(state).json };
    }

    // Prose is the fallback for every kind this build has not heard of, which is `strategyFor`'s
    // own rule (ADR-0009) rather than a second one invented here.
    const materialized = noteStrategy.materialize(state);
    if (materialized.json === null) {
      return null;
    }

    return { schemaVersion: doc.schema_version, prosemirror: materialized.json };
  } finally {
    // Released before the next item is read, so a subtree export's ceiling is one document rather
    // than all of them.
    state.destroy();
  }
}
