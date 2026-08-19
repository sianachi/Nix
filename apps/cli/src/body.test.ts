import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { prosemirrorJSONToYDoc, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import { nixSchema } from '@nix/editor-schema';
import { markdownToDocument } from '@nix/markdown';
import { readBodyMarkdown, writeBodyMarkdown } from './body.ts';

const COLLAB = 'http://collab.test';
const ITEM = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'jwt-1';

function doc(text: string): unknown {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

/** A base64 Yjs update whose `default` fragment holds the given prose, as collab would return. */
function updateFor(prose: unknown): string {
  const ydoc = prosemirrorJSONToYDoc(nixSchema, prose, 'default');
  return Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString('base64');
}

function updatesPage(updates: { seq: number; update: string }[], hasMore = false): Response {
  return new Response(
    JSON.stringify({ docId: 'd1', headSeq: updates.at(-1)?.seq ?? 0, schemaVersion: 2, updates, hasMore }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/** Canonicalise a prose doc through the schema so a comparison is over meaning, not defaults. */
function canonical(prose: unknown): unknown {
  return nixSchema.nodeFromJSON(prose).toJSON();
}

describe('readBodyMarkdown', () => {
  it('catches up the update log and renders the body as Markdown', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(updatesPage([{ seq: 1, update: updateFor(doc('Hello world')) }])));

    const body = await readBodyMarkdown({ collabUrl: COLLAB, itemId: ITEM, token: TOKEN, fetchImpl });

    expect(body.markdown.trim()).toBe('Hello world');
    expect(body.empty).toBe(false);
    expect(fetchImpl).toHaveBeenCalledWith(
      `${COLLAB}/documents/${ITEM}/updates?after=0`,
      expect.objectContaining({ headers: { authorization: `Bearer ${TOKEN}` } }),
    );
  });

  it('reports an item with no body log as empty', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(updatesPage([])));

    const body = await readBodyMarkdown({ collabUrl: COLLAB, itemId: ITEM, token: TOKEN, fetchImpl });

    expect(body.empty).toBe(true);
  });

  it('walks multiple pages of updates', async () => {
    const first = updateFor(doc('page one only'));
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(updatesPage([{ seq: 1, update: first }], true))
      .mockResolvedValueOnce(updatesPage([], false));

    const body = await readBodyMarkdown({ collabUrl: COLLAB, itemId: ITEM, token: TOKEN, fetchImpl });

    expect(body.markdown.trim()).toBe('page one only');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('writeBodyMarkdown', () => {
  it('posts a delta that reconstructs the intended body over the current state', async () => {
    const starting = updateFor(doc('the old body'));
    let posted: string | null = null;

    const fetchImpl = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes('/updates?after=')) {
        return Promise.resolve(updatesPage([{ seq: 1, update: starting }]));
      }
      posted = (JSON.parse(init?.body as string) as { update: string }).update;
      return Promise.resolve(
        new Response(JSON.stringify({ seq: '2' }), { status: 202, headers: { 'content-type': 'application/json' } }),
      );
    });

    const result = await writeBodyMarkdown({
      collabUrl: COLLAB,
      itemId: ITEM,
      token: TOKEN,
      markdown: '# A new heading\n\nand a fresh paragraph.',
      fetchImpl,
    });

    expect(result.bytes).toBeGreaterThan(0);
    expect(posted).not.toBeNull();

    // Apply the current state and then the posted delta to a fresh doc, exactly as the
    // collaboration service does, and confirm the body is now what the Markdown described.
    const reconstructed = new Y.Doc();
    Y.applyUpdate(reconstructed, new Uint8Array(Buffer.from(starting, 'base64')));
    Y.applyUpdate(reconstructed, new Uint8Array(Buffer.from(posted as unknown as string, 'base64')));

    const expected = markdownToDocument('# A new heading\n\nand a fresh paragraph.');
    expect(expected.ok).toBe(true);
    if (expected.ok) {
      expect(canonical(yXmlFragmentToProseMirrorRootNode(reconstructed.getXmlFragment('default'), nixSchema).toJSON())).toEqual(canonical(expected.doc));
    }
  });

  it('treats empty Markdown as clearing the body to an empty document, not as an error', async () => {
    // Empty input is a valid (empty) body, so `note write < /dev/null` clears a note rather than
    // failing. The guard against an *unparseable* body still stands for input the schema refuses;
    // markdown-it does not produce such input from text, so that path is the parser's own to test.
    let posted: string | null = null;
    const fetchImpl = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes('/updates?after=')) {
        return Promise.resolve(updatesPage([{ seq: 1, update: updateFor(doc('was here')) }]));
      }
      posted = (JSON.parse(init?.body as string) as { update: string }).update;
      return Promise.resolve(new Response(JSON.stringify({ seq: '2' }), { status: 202 }));
    });

    const result = await writeBodyMarkdown({ collabUrl: COLLAB, itemId: ITEM, token: TOKEN, markdown: '', fetchImpl });

    expect(result.bytes).toBeGreaterThan(0);
    expect(posted).not.toBeNull();
  });
});
