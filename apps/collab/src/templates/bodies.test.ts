import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import * as Y from 'yjs';

import { strategyFor } from '../documents/body-kinds.ts';
import { LIMITS } from '../documents/limits.ts';
import {
  copyBodies,
  documentFromArchiveBody,
  remapItemReferences,
  validateArchiveBodies,
  writeArchiveBodies,
} from './bodies.ts';

describe('template body reference remapping', () => {
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
});

describe('template body materialization', () => {
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
});

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
