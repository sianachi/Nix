import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { z } from 'zod';

import {
  parseCanvasElements,
  readCanvasBody,
  writeCanvasBody,
  type CanvasElement,
} from './canvas-body.ts';

const REQUEST = {
  collabUrl: 'http://collab.test',
  itemId: '11111111-1111-4111-8111-111111111111',
  token: 'test-token',
};
const DOC_ID = '22222222-2222-4222-8222-222222222222';
const element = (id: string, extra: Record<string, unknown> = {}): CanvasElement => ({
  id,
  type: 'rectangle',
  version: 1,
  versionNonce: 10,
  ...extra,
});

function document(elements: readonly CanvasElement[]): Y.Doc {
  const doc = new Y.Doc();
  for (const value of elements) doc.getMap('elements').set(value.id, value);
  return doc;
}

function page(
  doc: Y.Doc,
  seq = 1,
  options: { readonly checkpoint?: boolean; readonly hasMore?: boolean } = {},
): Response {
  const encoded = Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
  return new Response(
    JSON.stringify({
      docId: DOC_ID,
      headSeq: String(seq),
      schemaVersion: 1,
      updates: options.checkpoint ? [] : [{ seq: String(seq), update: encoded }],
      ...(options.checkpoint ? { checkpoint: { seq: String(seq), update: encoded } } : {}),
      hasMore: options.hasMore ?? false,
    }),
  );
}

describe('canvas body', () => {
  it('reads retained scene elements, including tombstones and metadata, in fractional-index order', async () => {
    const result = await readCanvasBody({
      ...REQUEST,
      fetchImpl: vi.fn(() =>
        Promise.resolve(
          page(
            document([
              element('core', {
                index: 'a02',
                customData: { mermaid: { source: 'flowchart LR\\nCore-->Collab' } },
              }),
              element('old', { index: 'a01', isDeleted: true }),
            ]),
          ),
        ),
      ),
    });

    expect(result.elements).toEqual([
      element('old', { index: 'a01', isDeleted: true }),
      element('core', {
        index: 'a02',
        customData: { mermaid: { source: 'flowchart LR\\nCore-->Collab' } },
      }),
    ]);
  });

  it('uses the current document identity guard while retaining concurrent Yjs changes', async () => {
    const saved = document([element('edited'), element('retained')]);
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(saved));
    remote.getMap('elements').set('concurrent', element('concurrent'));
    const fetchImpl = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes('?after=')) return Promise.resolve(page(saved));
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
      const body = z
        .object({ expectedDocId: z.string(), update: z.string() })
        .parse(JSON.parse(init.body));
      expect(body.expectedDocId).toBe(DOC_ID);
      expect(body).not.toHaveProperty('expectedHeadSeq');
      Y.applyUpdate(remote, new Uint8Array(Buffer.from(body.update, 'base64')));
      return Promise.resolve(new Response(JSON.stringify({ seq: '2' }), { status: 202 }));
    });

    await expect(
      writeCanvasBody({
        ...REQUEST,
        elements: [element('edited', { version: 2, text: 'Updated' })],
        fetchImpl,
      }),
    ).resolves.toMatchObject({ changed: 1, seq: '2' });
    expect(remote.getMap('elements').toJSON()).toMatchObject({
      edited: element('edited', { version: 2, text: 'Updated' }),
      retained: element('retained'),
      concurrent: element('concurrent'),
    });
  });

  it('uses the retained checkpoint when history before it was pruned', async () => {
    const saved = document([element('kept')]);
    await expect(
      readCanvasBody({
        ...REQUEST,
        fetchImpl: vi.fn(() => Promise.resolve(page(saved, 7, { checkpoint: true }))),
      }),
    ).resolves.toMatchObject({
      elements: [element('kept')],
      headSeq: '7',
    });
  });

  it('refuses an update larger than Collab accepts before applying it', async () => {
    const oversized = Buffer.alloc(1024 * 1024 + 1).toString('base64');
    await expect(
      readCanvasBody({
        ...REQUEST,
        fetchImpl: vi.fn(() =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                docId: DOC_ID,
                headSeq: '1',
                schemaVersion: 1,
                updates: [{ seq: '1', update: oversized }],
                hasMore: false,
              }),
            ),
          ),
        ),
      }),
    ).rejects.toThrow(/1048576 byte collaboration limit/);
  });

  it('reports a replaced body as a guarded conflict', async () => {
    const fetchImpl = vi.fn((url: string) => {
      if (url.includes('?after=')) return Promise.resolve(page(document([element('edited')])));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            code: 'document_changed',
            detail: 'The document body changed before this upload.',
          }),
          { status: 409 },
        ),
      );
    });
    await expect(
      writeCanvasBody({ ...REQUEST, elements: [element('edited', { version: 2 })], fetchImpl }),
    ).rejects.toMatchObject({ status: 409, code: 'document_changed' });
  });

  it('rejects duplicate and stale scene input before posting', async () => {
    expect(() => parseCanvasElements([element('same'), element('same')])).toThrow(/occurs twice/);
    const fetchImpl = vi.fn(() =>
      Promise.resolve(page(document([element('same', { version: 2 })]))),
    );
    await expect(
      writeCanvasBody({ ...REQUEST, elements: [element('same')], fetchImpl }),
    ).rejects.toThrow(/stale/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
