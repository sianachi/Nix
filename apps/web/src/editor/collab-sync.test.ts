import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { base64ToBytes, bytesToBase64, startCollabSync, type SyncState } from './collab-sync';

/**
 * The document transport, without a server.
 *
 * What matters here is not the wire format but the promise the interface makes on top of it: a
 * local edit applies immediately, a failed post is retried rather than dropped, and the state the
 * footer reports is the truth about whether the server has the edit.
 */

afterEach(() => {
  vi.useRealTimers();
});

function emptyCatchUp(): Response {
  return new Response(JSON.stringify({ docId: 'doc', headSeq: '0', updates: [], hasMore: false }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('base64 framing', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255, 42]);

    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it('round-trips a real Yjs update', () => {
    const doc = new Y.Doc();
    doc.getMap('m').set('key', 'value');
    const update = Y.encodeStateAsUpdate(doc);

    const applied = new Y.Doc();
    Y.applyUpdate(applied, base64ToBytes(bytesToBase64(update)));

    expect(applied.getMap('m').get('key')).toBe('value');
  });
});

describe('synchronisation', () => {
  it('applies a local edit to the document immediately, before any request', () => {
    const doc = new Y.Doc();
    const fetchImpl = vi.fn(() => Promise.resolve(emptyCatchUp()));

    const sync = startCollabSync({
      itemId: 'item',
      doc,
      fragmentName: 'default',
      getAccessToken: () => Promise.resolve('token'),
      onState: () => undefined,
      fetchImpl,
    });

    doc.getMap('m').set('typed', 'now');

    // The network is catch-up, never the thing between a keystroke and the screen.
    expect(doc.getMap('m').get('typed')).toBe('now');

    sync.destroy();
  });

  it('reports pending the moment something is typed, and not saved', () => {
    const doc = new Y.Doc();
    const states: SyncState[] = [];

    const sync = startCollabSync({
      itemId: 'item',
      doc,
      fragmentName: 'default',
      getAccessToken: () => Promise.resolve('token'),
      onState: (state) => states.push(state),
      fetchImpl: () => Promise.resolve(emptyCatchUp()),
    });

    doc.getMap('m').set('typed', 'now');

    expect(states).toContain('pending');

    sync.destroy();
  });

  it('posts what was typed, once the pause has passed', async () => {
    vi.useFakeTimers();

    const doc = new Y.Doc();
    const posts: string[] = [];

    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push(typeof init.body === 'string' ? init.body : '');
        return Promise.resolve(new Response('{}', { status: 202 }));
      }

      return Promise.resolve(emptyCatchUp());
    });

    const sync = startCollabSync({
      itemId: 'item',
      doc,
      fragmentName: 'default',
      getAccessToken: () => Promise.resolve('token'),
      onState: () => undefined,
      debounceMs: 10,
      fetchImpl,
    });

    doc.getMap('m').set('typed', 'now');
    await vi.advanceTimersByTimeAsync(50);

    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain('"clientId"');

    sync.destroy();
  });

  it('keeps an edit the server refused rather than dropping it', async () => {
    vi.useFakeTimers();

    const doc = new Y.Doc();
    const states: SyncState[] = [];
    let attempts = 0;

    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        attempts += 1;
        return Promise.resolve(new Response('{}', { status: 503 }));
      }

      return Promise.resolve(emptyCatchUp());
    });

    const sync = startCollabSync({
      itemId: 'item',
      doc,
      fragmentName: 'default',
      getAccessToken: () => Promise.resolve('token'),
      onState: (state) => states.push(state),
      debounceMs: 10,
      fetchImpl,
    });

    doc.getMap('m').set('typed', 'now');
    await vi.advanceTimersByTimeAsync(50);

    // Losing an edit somebody has already watched appear on their own screen is the one outcome
    // this whole design exists to prevent, so a refusal is reported and retried, never swallowed.
    expect(attempts).toBeGreaterThan(0);
    expect(states).toContain('offline');

    doc.getMap('m').set('typed again', 'now');
    await vi.advanceTimersByTimeAsync(50);

    expect(attempts).toBeGreaterThan(1);

    sync.destroy();
  });

  it('applies a remote update without posting it straight back', async () => {
    vi.useFakeTimers();

    const remote = new Y.Doc();
    remote.getMap('m').set('theirs', 'edit');
    const update = bytesToBase64(Y.encodeStateAsUpdate(remote));

    const doc = new Y.Doc();
    let posts = 0;

    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts += 1;
        return Promise.resolve(new Response('{}', { status: 202 }));
      }

      return Promise.resolve(
        new Response(
          JSON.stringify({
            docId: 'doc',
            headSeq: '1',
            updates: [{ seq: '1', clientId: 'somebody-else', update }],
            hasMore: false,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    });

    const sync = startCollabSync({
      itemId: 'item',
      doc,
      fragmentName: 'default',
      getAccessToken: () => Promise.resolve('token'),
      onState: () => undefined,
      debounceMs: 10,
      fetchImpl,
    });

    await vi.advanceTimersByTimeAsync(50);

    expect(doc.getMap('m').get('theirs')).toBe('edit');

    // Echoing a remote update back would make two clients bounce the same edit between them for
    // as long as both stayed open.
    expect(posts).toBe(0);

    sync.destroy();
  });
});
