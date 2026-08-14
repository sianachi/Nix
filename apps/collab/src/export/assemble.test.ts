import { describe, expect, it } from 'vitest';

import type { ViewsSnapshot } from '@nix/export';

import type { ChildPage, CoreClient, CoreItem } from '../core/client.ts';
import {
  EXPORT_LIMITS,
  VIEW_ROW_LIMIT,
  buildManifest,
  enumerateSubtree,
  gatherMetadata,
  gatherViewRows,
} from './assemble.ts';

const WORKSPACE = 'c1000000-0000-4000-8000-000000000011';

function item(id: string, overrides: Partial<CoreItem> = {}): CoreItem {
  return {
    id,
    workspaceId: WORKSPACE,
    parentId: null,
    type: 'note',
    title: id,
    hasChildren: false,
    seq: '1',
    lifecycleState: 'active',
    properties: {},
    createdAt: '2026-07-29T10:00:00Z',
    updatedAt: '2026-07-29T10:00:00Z',
    ...overrides,
  };
}

/** A Core whose tree is a plain map of parent to children. */
function coreWith(tree: Readonly<Record<string, readonly CoreItem[]>>): CoreClient {
  return {
    getItem: (_token, id) => Promise.resolve(item(id)),
    listChildren: (_token, _workspace, parentId): Promise<ChildPage | null> =>
      Promise.resolve({ items: tree[parentId] ?? [], nextCursor: null }),
    getSchema: () => Promise.resolve(null),
    getViews: () => Promise.resolve(null),
  };
}

const root = item('root', { hasChildren: true });

describe('enumerateSubtree', () => {
  it('takes only the root when the scope is the item alone', async () => {
    const core = coreWith({ root: [item('a'), item('b')] });

    const tree = await enumerateSubtree(core, {
      token: 't',
      root,
      scope: 'item',
      includeDeleted: false,
    });

    expect(tree.items.map((each) => each.id)).toEqual(['root']);
  });

  it('walks parents before children, so an import can create them in order', async () => {
    const core = coreWith({
      root: [item('a', { hasChildren: true }), item('b')],
      a: [item('a1'), item('a2')],
    });

    const tree = await enumerateSubtree(core, {
      token: 't',
      root,
      scope: 'subtree',
      includeDeleted: false,
    });

    const order = tree.items.map((each) => each.id);
    expect(order).toEqual(['root', 'a', 'a1', 'a2', 'b']);
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('a1'));
  });

  it('names a soft-deleted child it left out rather than dropping it silently', async () => {
    const core = coreWith({
      root: [item('a'), item('gone', { lifecycleState: 'deleted' })],
    });

    const tree = await enumerateSubtree(core, {
      token: 't',
      root,
      scope: 'subtree',
      includeDeleted: false,
    });

    expect(tree.items.map((each) => each.id)).toEqual(['root', 'a']);
    expect(tree.omitted).toHaveLength(1);
    expect(tree.omitted[0]).toMatchObject({
      id: 'gone',
      parentId: 'root',
      reason: 'soft-deleted',
    });
    expect(tree.omitted[0]?.detail).toContain('deleted');
  });

  it('includes soft-deleted descendants when asked, and says so', async () => {
    const core = coreWith({ root: [item('gone', { lifecycleState: 'deleted' })] });

    const tree = await enumerateSubtree(core, {
      token: 't',
      root,
      scope: 'subtree',
      includeDeleted: true,
    });

    expect(tree.items.map((each) => each.id)).toEqual(['root', 'gone']);
    expect(tree.omitted).toEqual([]);
  });

  it('records a branch it could not list rather than reporting a smaller tree', async () => {
    const core: CoreClient = {
      ...coreWith({}),
      listChildren: () => Promise.resolve(null),
    };

    const tree = await enumerateSubtree(core, {
      token: 't',
      root,
      scope: 'subtree',
      includeDeleted: false,
    });

    expect(tree.omitted).toHaveLength(1);
    expect(tree.omitted[0]).toMatchObject({
      id: null,
      parentId: 'root',
      reason: 'not-readable',
    });
  });

  it('stops at the item ceiling and states what it stopped at', async () => {
    const many = Array.from({ length: EXPORT_LIMITS.maxItems + 5 }, (_unused, index) =>
      item(`child-${String(index)}`),
    );

    const tree = await enumerateSubtree(coreWith({ root: many }), {
      token: 't',
      root,
      scope: 'subtree',
      includeDeleted: false,
    });

    expect(tree.items).toHaveLength(EXPORT_LIMITS.maxItems);
    expect(tree.omitted).toHaveLength(6);
    expect(tree.omitted.every((each) => each.reason === 'limit-reached')).toBe(true);
  });
});

describe('buildManifest', () => {
  it('carries the effective schema at the root, not just what the root declares', async () => {
    const declared = {
      properties: [
        { key: 'status', label: 'Status', type: 'select', options: ['a'], required: false },
        { key: 'owner', label: 'Owner', type: 'text', options: [], required: false },
      ],
      declared: [{ key: 'owner', label: 'Owner', type: 'text', options: [], required: false }],
      inherit: true,
    };

    const core: CoreClient = { ...coreWith({}), getSchema: () => Promise.resolve(declared) };
    const tree = { items: [root], omitted: [] };
    const metadata = await gatherMetadata(core, 't', tree.items);

    const manifest = buildManifest({
      root,
      tree,
      metadata,
      includeDeleted: false,
      exportedAt: new Date('2026-07-29T10:00:00Z'),
    });

    // 'status' is inherited from an ancestor outside the archive. Carrying only 'owner' would
    // import items holding a status no schema declares.
    expect(manifest.rootEffectiveSchema?.properties.map((each) => each.key)).toEqual([
      'status',
      'owner',
    ]);
  });

  it('claims no loss, which is what makes this the lossless format', () => {
    const manifest = buildManifest({
      root,
      tree: { items: [root], omitted: [] },
      metadata: { schemas: new Map(), views: new Map(), viewRows: new Map() },
      includeDeleted: false,
      exportedAt: new Date('2026-07-29T10:00:00Z'),
    });

    expect(manifest.loss).toEqual([]);
    expect(manifest.includesDeleted).toBe(false);
    expect(manifest.root).toBe('root');
  });
});

/**
 * The children a view draws.
 *
 * **Gathered for the item that has the view, not for the export's scope.** Choosing "this item" and
 * asking for a PDF used to produce a document with no board in it, because an item-scope export
 * carries no children at all - which reads as the feature being broken rather than as the scope
 * being narrow.
 */
describe('gatherViewRows', () => {
  const VIEWS: ViewsSnapshot = {
    views: [
      {
        id: 'v1',
        name: 'Board',
        kind: 'board',
        columns: [],
        groupBy: 'status',
        groupOrder: [],
        dateProperty: null,
        sortBy: null,
        sortDescending: false,
        mode: null,
        coverProperty: null,
        endDateProperty: null,
        cardSize: null,
      },
    ],
    default: 'v1',
  };

  it('reads the children of an item that offers a view', async () => {
    const core = coreWith({ root: [item('a'), item('b')] });

    const rows = await gatherViewRows(core, 't', [root], new Map([['root', VIEWS]]));

    expect(rows.get('root')?.rows.map((row) => row.id)).toEqual(['a', 'b']);
    expect(rows.get('root')?.truncated).toBe(false);
  });

  it('reads nothing for an item that offers none, so an export pays only for what it draws', async () => {
    const core = coreWith({ root: [item('a')] });

    const rows = await gatherViewRows(core, 't', [root], new Map([['root', null]]));

    expect(rows.has('root')).toBe(false);
  });

  it('leaves out a deleted child, which the view would not show either', async () => {
    const core = coreWith({
      root: [item('a'), item('gone', { lifecycleState: 'deleted' })],
    });

    const rows = await gatherViewRows(core, 't', [root], new Map([['root', VIEWS]]));

    expect(rows.get('root')?.rows.map((row) => row.id)).toEqual(['a']);
  });

  it('says it was truncated rather than drawing a partial view that looks whole', async () => {
    const many = Array.from({ length: VIEW_ROW_LIMIT + 3 }, (_unused, index) =>
      item(`child-${String(index)}`),
    );

    const rows = await gatherViewRows(
      coreWith({ root: many }),
      't',
      [root],
      new Map([['root', VIEWS]]),
    );

    expect(rows.get('root')?.rows).toHaveLength(VIEW_ROW_LIMIT);
    expect(rows.get('root')?.truncated).toBe(true);
  });

  it('draws an empty view rather than failing the export when a listing is refused', async () => {
    const refusing: CoreClient = {
      getItem: (_token, id) => Promise.resolve(item(id)),
      listChildren: () => Promise.resolve(null),
      getSchema: () => Promise.resolve(null),
      getViews: () => Promise.resolve(null),
    };

    const rows = await gatherViewRows(refusing, 't', [root], new Map([['root', VIEWS]]));

    expect(rows.get('root')).toEqual({ rows: [], truncated: true });
  });
});
