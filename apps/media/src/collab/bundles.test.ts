import type { ItemBundle } from '@nix/export';
import { describe, expect, it } from 'vitest';

import { BundleRefusal, createBundleReader } from './bundles.ts';

/**
 * Reading a bundle stream.
 *
 * **Most of this suite is about refusing a stream that looks fine.** Truncated NDJSON is still a run
 * of valid JSON lines, so every check below stands between a short read and a plausible, complete-
 * looking file that quietly lost half a document. That failure has no downstream detector, which is
 * why the checks live here and why they are tested one at a time.
 */

const MANIFEST = {
  format: 'nix-archive',
  formatVersion: 1,
  schemaVersion: 2,
  exportedAt: '2026-08-13T00:00:00Z',
  root: 'a',
  rootEffectiveSchema: null,
  includesDeleted: false,
  items: [{ id: 'a', parentId: null, seq: '1000', title: 'A', type: 'note' }],
  omitted: [],
  loss: [],
};

const BUNDLE = { id: 'a', title: 'A', body: null };

function streamOf(...lines: readonly unknown[]): Response {
  const text = lines.map((line) => `${JSON.stringify(line)}\n`).join('');
  return new Response(text, { status: 200 });
}

function reader(response: Response | (() => Response), maxBytes = 1024 * 1024) {
  return createBundleReader({
    collabBaseUrl: 'http://collab.test',
    internalSecret: 'secret',
    maxBytes,
    fetch: () => Promise.resolve(typeof response === 'function' ? response() : response),
  });
}

async function drain(bundles: AsyncGenerator<ItemBundle>): Promise<ItemBundle[]> {
  const read: ItemBundle[] = [];

  for await (const bundle of bundles) {
    read.push(bundle);
  }

  return read;
}

function request() {
  return {
    token: 'token',
    itemId: 'c1000000-0000-4000-8000-000000000031',
    scope: 'item' as const,
    signal: AbortSignal.timeout(5_000),
  };
}

describe('a well-formed stream', () => {
  it('gives the manifest first, then the bundles', async () => {
    const stream = await reader(streamOf(MANIFEST, BUNDLE, { end: true, items: 1 })).read(
      request(),
    );

    expect(stream.manifest.format).toBe('nix-archive');
    expect((await drain(stream.bundles)).map((bundle) => bundle.id)).toEqual(['a']);
  });

  it('carries an export with no items at all', async () => {
    const stream = await reader(streamOf(MANIFEST, { end: true, items: 0 })).read(request());

    expect(await drain(stream.bundles)).toEqual([]);
  });
});

describe('a stream that stops early', () => {
  it('is refused when the sentinel never arrives', async () => {
    const stream = await reader(streamOf(MANIFEST, BUNDLE)).read(request());

    await expect(drain(stream.bundles)).rejects.toThrow(/ended early/);
  });

  it('is refused when the sentinel disagrees with what arrived', async () => {
    // The case a sentinel alone would miss: the stream ends tidily and is still short.
    const stream = await reader(streamOf(MANIFEST, BUNDLE, { end: true, items: 4 })).read(
      request(),
    );

    await expect(drain(stream.bundles)).rejects.toThrow(/said it held 4 items and carried 1/);
  });

  it('is refused when it ends mid-line', async () => {
    const partial = `${JSON.stringify(MANIFEST)}\n${JSON.stringify(BUNDLE).slice(0, 10)}`;
    const stream = await reader(new Response(partial, { status: 200 })).read(request());

    await expect(drain(stream.bundles)).rejects.toThrow(/ended mid-line/);
  });
});

describe('a stream that is not what it claims', () => {
  it('is refused when it does not begin with a manifest', async () => {
    await expect(reader(streamOf(BUNDLE)).read(request())).rejects.toThrow(/begin with a manifest/);
  });

  it('is refused when a line is not readable', async () => {
    const stream = await reader(new Response(`${JSON.stringify(MANIFEST)}\nnot json\n`)).read(
      request(),
    );

    await expect(drain(stream.bundles)).rejects.toThrow(/not readable/);
  });

  it('is refused when a line is neither an item nor the sentinel', async () => {
    const stream = await reader(streamOf(MANIFEST, { something: 'else' })).read(request());

    await expect(drain(stream.bundles)).rejects.toThrow(/not an item/);
  });

  it('is refused when it is empty', async () => {
    await expect(reader(new Response('', { status: 200 })).read(request())).rejects.toThrow(
      /was empty/,
    );
  });
});

describe('a stream larger than this service will read', () => {
  it('is refused on bytes rather than on lines', async () => {
    // Bytes, because one unbounded line is the shape that matters: a line-counting limit would let
    // a single hostile line fill memory before it was ever counted.
    //
    // The refusal lands on the read itself rather than on the iteration, because the ceiling is
    // checked per chunk and the first chunk already exceeds it - which is the point. A limit that
    // only fired once a caller started iterating would have held the bytes in memory first.
    const big = { ...BUNDLE, filler: 'x'.repeat(4096) };

    await expect(
      reader(streamOf(MANIFEST, big, { end: true, items: 1 }), 512).read(request()),
    ).rejects.toThrow(/larger than one request carries/);
  });
});

describe('what the other service said', () => {
  it('is forwarded with its own status and sentence', async () => {
    const refusal = new Response(
      JSON.stringify({ code: 'document_not_found', detail: 'No such item.' }),
      { status: 404 },
    );

    await expect(reader(refusal).read(request())).rejects.toMatchObject({
      status: 404,
      code: 'document_not_found',
      message: 'No such item.',
    });
  });

  it('becomes a bad-gateway when the service cannot be reached at all', async () => {
    const unreachable = createBundleReader({
      collabBaseUrl: 'http://collab.test',
      internalSecret: 'secret',
      maxBytes: 1024,
      fetch: () => Promise.reject(new Error('ECONNREFUSED')),
    });

    // This service's problem to report, not the caller's fault - so a 502, not a 404.
    await expect(unreachable.read(request())).rejects.toMatchObject({ status: 502 });
  });
});

describe('the two facts it presents', () => {
  it('sends the internal secret and the caller own token, and asks for NDJSON', async () => {
    const seen: { url?: string; headers?: Record<string, string> } = {};

    const reading = createBundleReader({
      collabBaseUrl: 'http://collab.test',
      internalSecret: 'the-secret',
      maxBytes: 1024 * 1024,
      fetch: (url, init) => {
        seen.url = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
        seen.headers = init?.headers as Record<string, string>;
        return Promise.resolve(streamOf(MANIFEST, { end: true, items: 0 }));
      },
    });

    await reading.read({ ...request(), scope: 'subtree' });

    expect(seen.url).toContain('/documents/c1000000-0000-4000-8000-000000000031/bundles');
    expect(seen.url).toContain('scope=subtree');
    // Which service is asking, and on whose behalf. Both, always.
    expect(seen.headers?.['x-nix-internal-secret']).toBe('the-secret');
    expect(seen.headers?.authorization).toBe('Bearer token');
  });
});

describe('BundleRefusal', () => {
  it('carries the status a caller should answer with', () => {
    const refusal = new BundleRefusal(413, 'export_too_large', 'Too big.');

    expect(refusal.status).toBe(413);
    expect(refusal.code).toBe('export_too_large');
    expect(refusal.name).toBe('BundleRefusal');
  });
});
