import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  prosemirrorJSONToYDoc,
  updateYFragment,
  yXmlFragmentToProseMirrorRootNode,
} from 'y-prosemirror';
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

function updatesPage(
  updates: { seq: number | string; update: string }[],
  hasMore = false,
  checkpoint?: { seq: string; update: string },
): Response {
  return new Response(
    JSON.stringify({
      docId: 'd1',
      headSeq: updates.at(-1)?.seq ?? checkpoint?.seq ?? 0,
      schemaVersion: 2,
      updates,
      hasMore,
      ...(checkpoint === undefined ? {} : { checkpoint }),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function checkpointAndTail(): { checkpoint: string; tail: string } {
  const ydoc = prosemirrorJSONToYDoc(nixSchema, doc('Retained checkpoint'), 'default');
  const checkpoint = Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString('base64');
  const before = Y.encodeStateVector(ydoc);
  updateYFragment(
    ydoc,
    ydoc.getXmlFragment('default'),
    nixSchema.nodeFromJSON(doc('Retained checkpoint and tail')),
    { mapping: new Map(), isOMark: new Map() },
  );
  return { checkpoint, tail: Buffer.from(Y.encodeStateAsUpdate(ydoc, before)).toString('base64') };
}

/** Canonicalise a prose doc through the schema so a comparison is over meaning, not defaults. */
function canonical(prose: unknown): unknown {
  return nixSchema.nodeFromJSON(prose).toJSON();
}

describe('readBodyMarkdown', () => {
  it('catches up the update log and renders the body as Markdown', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(updatesPage([{ seq: 1, update: updateFor(doc('Hello world')) }])),
    );

    const body = await readBodyMarkdown({
      collabUrl: COLLAB,
      itemId: ITEM,
      token: TOKEN,
      fetchImpl,
    });

    expect(body.markdown.trim()).toBe('Hello world');
    expect(body.empty).toBe(false);
    expect(fetchImpl).toHaveBeenCalledWith(
      `${COLLAB}/documents/${ITEM}/updates?after=0`,
      expect.objectContaining({ headers: { authorization: `Bearer ${TOKEN}` } }),
    );
  });

  it('reports an item with no body log as empty', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(updatesPage([])));

    const body = await readBodyMarkdown({
      collabUrl: COLLAB,
      itemId: ITEM,
      token: TOKEN,
      fetchImpl,
    });

    expect(body.empty).toBe(true);
  });

  it('walks multiple pages of updates', async () => {
    const first = updateFor(doc('page one only'));
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(updatesPage([{ seq: 1, update: first }], true))
      .mockResolvedValueOnce(updatesPage([], false));

    const body = await readBodyMarkdown({
      collabUrl: COLLAB,
      itemId: ITEM,
      token: TOKEN,
      fetchImpl,
    });

    expect(body.markdown.trim()).toBe('page one only');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reads a retained checkpoint and its tail after covered updates were pruned', async () => {
    const { checkpoint, tail } = checkpointAndTail();
    const body = await readBodyMarkdown({
      collabUrl: COLLAB,
      itemId: ITEM,
      token: TOKEN,
      fetchImpl: () =>
        Promise.resolve(
          updatesPage([{ seq: '13', update: tail }], false, { seq: '12', update: checkpoint }),
        ),
    });
    expect(body.markdown.trim()).toBe('Retained checkpoint and tail');
    expect(body.empty).toBe(false);
  });

  it('reads a checkpoint-only body without reporting it empty', async () => {
    const { checkpoint } = checkpointAndTail();
    const body = await readBodyMarkdown({
      collabUrl: COLLAB,
      itemId: ITEM,
      token: TOKEN,
      fetchImpl: () => Promise.resolve(updatesPage([], false, { seq: '12', update: checkpoint })),
    });
    expect(body.markdown.trim()).toBe('Retained checkpoint');
    expect(body.empty).toBe(false);
  });

  it('skips checkpoint-covered pages and advances without losing sequence precision', async () => {
    const { checkpoint, tail } = checkpointAndTail();
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(
        updatesPage([{ seq: '1', update: checkpoint }], true, {
          seq: '9007199254740992',
          update: checkpoint,
        }),
      )
      .mockResolvedValueOnce(updatesPage([{ seq: '9007199254740993', update: tail }]));
    const body = await readBodyMarkdown({
      collabUrl: COLLAB,
      itemId: ITEM,
      token: TOKEN,
      fetchImpl,
    });
    expect(body.markdown.trim()).toBe('Retained checkpoint and tail');
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      `${COLLAB}/documents/${ITEM}/updates?after=9007199254740992`,
      expect.anything(),
    );
  });

  it('refuses invalid catch-up data and a document identity change during pagination', async () => {
    await expect(
      readBodyMarkdown({
        collabUrl: COLLAB,
        itemId: ITEM,
        token: TOKEN,
        fetchImpl: () => Promise.resolve(new Response('{"checkpoint":{"seq":"-1"}}')),
      }),
    ).rejects.toThrow();
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(
        updatesPage([{ seq: 1, update: updateFor(doc('First document')) }], true),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            docId: 'replaced',
            headSeq: '1',
            schemaVersion: 2,
            updates: [],
            hasMore: false,
          }),
        ),
      );
    await expect(
      readBodyMarkdown({ collabUrl: COLLAB, itemId: ITEM, token: TOKEN, fetchImpl }),
    ).rejects.toThrow('changed during this read');
  });
});

describe('writeBodyMarkdown', () => {
  it('guards the caught-up document identity and surfaces replacement refusals', async () => {
    const fetchImpl = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes('/updates?after=')) {
        return Promise.resolve(updatesPage([{ seq: 1, update: updateFor(doc('Current body')) }]));
      }
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON update.');
      const posted: unknown = JSON.parse(init.body);
      expect(posted).toMatchObject({ expectedDocId: 'd1' });
      return Promise.resolve(
        new Response('{"detail":"The note body was replaced. Recover the pending draft."}', {
          status: 409,
        }),
      );
    });
    await expect(
      writeBodyMarkdown({
        collabUrl: COLLAB,
        itemId: ITEM,
        token: TOKEN,
        markdown: 'Must not enter a different document.',
        fetchImpl,
      }),
    ).rejects.toThrow('The note body was replaced. Recover the pending draft.');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each(['gap', 'pruned tail'])(
    'refuses an incomplete %s before posting a write',
    async (kind) => {
      const { checkpoint, tail } = checkpointAndTail();
      const fetchImpl = vi
        .fn<() => Promise<Response>>()
        .mockResolvedValueOnce(updatesPage([{ seq: '1', update: checkpoint }], true))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              docId: 'd1',
              headSeq: '3',
              schemaVersion: 2,
              updates: kind === 'gap' ? [{ seq: '3', update: tail }] : [],
              hasMore: false,
            }),
          ),
        );
      await expect(
        writeBodyMarkdown({
          collabUrl: COLLAB,
          itemId: ITEM,
          token: TOKEN,
          markdown: 'Must not overwrite missing content.',
          fetchImpl,
        }),
      ).rejects.toThrow('retained checkpoint');
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    },
  );

  it('preserves document identities when replacing a pruned checkpoint and tail', async () => {
    const { checkpoint, tail } = checkpointAndTail();
    let posted: string | undefined;
    await writeBodyMarkdown({
      collabUrl: COLLAB,
      itemId: ITEM,
      token: TOKEN,
      markdown: 'Changed after retention.',
      fetchImpl: (url, init) => {
        if (url.includes('/updates?after='))
          return Promise.resolve(
            updatesPage([{ seq: '13', update: tail }], false, { seq: '12', update: checkpoint }),
          );
        if (typeof init?.body !== 'string') throw new Error('Expected a JSON update.');
        const body: unknown = JSON.parse(init.body);
        if (
          typeof body !== 'object' ||
          body === null ||
          !('update' in body) ||
          typeof body.update !== 'string'
        )
          throw new Error('Expected a base64 update.');
        posted = body.update;
        return Promise.resolve(new Response('{"seq":"14"}', { status: 202 }));
      },
    });
    expect(posted).toBeDefined();
    if (posted === undefined) throw new Error('The write did not post an update.');
    const reconstructed = new Y.Doc();
    for (const update of [checkpoint, tail, posted])
      Y.applyUpdate(reconstructed, new Uint8Array(Buffer.from(update, 'base64')));
    const expected: unknown = nixSchema.nodeFromJSON(doc('Changed after retention.')).toJSON();
    expect(
      yXmlFragmentToProseMirrorRootNode(
        reconstructed.getXmlFragment('default'),
        nixSchema,
      ).toJSON(),
    ).toEqual(expected);
  });

  it('posts a delta that reconstructs the intended body over the current state', async () => {
    const starting = updateFor(doc('the old body'));
    let posted: string | null = null;

    const fetchImpl = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes('/updates?after=')) {
        return Promise.resolve(updatesPage([{ seq: 1, update: starting }]));
      }
      posted = (JSON.parse(init?.body as string) as { update: string }).update;
      return Promise.resolve(
        new Response(JSON.stringify({ seq: '2' }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        }),
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
    Y.applyUpdate(
      reconstructed,
      new Uint8Array(Buffer.from(posted as unknown as string, 'base64')),
    );

    const expected = markdownToDocument('# A new heading\n\nand a fresh paragraph.');
    expect(expected.ok).toBe(true);
    if (expected.ok) {
      expect(
        canonical(
          yXmlFragmentToProseMirrorRootNode(
            reconstructed.getXmlFragment('default'),
            nixSchema,
          ).toJSON(),
        ),
      ).toEqual(canonical(expected.doc));
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

    const result = await writeBodyMarkdown({
      collabUrl: COLLAB,
      itemId: ITEM,
      token: TOKEN,
      markdown: '',
      fetchImpl,
    });

    expect(result.bytes).toBeGreaterThan(0);
    expect(posted).not.toBeNull();
  });

  it('returns the parser scan paired with the body it writes', async () => {
    const fetchImpl = vi.fn((url: string) =>
      Promise.resolve(
        url.includes('/updates?after=')
          ? updatesPage([])
          : new Response(JSON.stringify({ seq: '1' }), { status: 202 }),
      ),
    );

    const result = await writeBodyMarkdown({
      collabUrl: COLLAB,
      itemId: ITEM,
      token: TOKEN,
      markdown: '[[Note]] ![[Embed]] ![local](./local.png)',
      fetchImpl,
    });

    expect(result.scan).toEqual({
      unresolvedWikiLinks: 1,
      unresolvedObsidianEmbeds: 1,
      unresolvedLocalImages: 1,
      unsupportedImageAddresses: 0,
      inlineImagesFlattened: 0,
    });
  });

  it('keeps a pre-parsed document inseparable from its supplied scan', async () => {
    const scan = {
      unresolvedWikiLinks: 2,
      unresolvedObsidianEmbeds: 3,
      unresolvedLocalImages: 4,
      unsupportedImageAddresses: 5,
      inlineImagesFlattened: 6,
    };
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON update.');
      const posted: unknown = JSON.parse(init.body);
      expect(posted).not.toHaveProperty('expectedDocId');
      return Promise.resolve(new Response(JSON.stringify({ seq: '1' }), { status: 202 }));
    });

    const result = await writeBodyMarkdown({
      collabUrl: COLLAB,
      itemId: ITEM,
      token: TOKEN,
      markdown: 'not reparsed',
      parsed: { doc: doc('already parsed'), scan },
      assumeEmpty: true,
      fetchImpl,
    });

    expect(result.scan).toBe(scan);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
