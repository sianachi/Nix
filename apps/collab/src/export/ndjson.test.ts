import type { ArchiveManifest, ItemBundle } from '@nix/export';
import { describe, expect, it } from 'vitest';

import { writeBundleStream } from './ndjson.ts';

/**
 * The bundle stream's framing.
 *
 * Every claim the reader on the other side is allowed to make about a stream is asserted here:
 * manifest first, one line per bundle, a sentinel last, and no document content able to split a
 * line. A reader that trusts any of those without this suite is trusting a comment.
 */

const MANIFEST: ArchiveManifest = {
  format: 'nix-archive',
  formatVersion: 1,
  schemaVersion: 2,
  exportedAt: '2026-08-13T00:00:00Z',
  root: 'root',
  rootEffectiveSchema: null,
  includesDeleted: false,
  items: [],
  omitted: [],
  loss: [],
};

function bundle(id: string, body: ItemBundle['body'] = null): ItemBundle {
  return {
    id,
    parentId: null,
    workspaceId: 'workspace',
    type: 'note',
    title: id,
    seq: '1000',
    lifecycleState: 'active',
    createdAt: '2026-08-13T00:00:00Z',
    updatedAt: '2026-08-13T00:00:00Z',
    properties: {},
    schema: null,
    views: null,
    body,
  };
}

async function* bundlesOf(...items: readonly ItemBundle[]): AsyncGenerator<ItemBundle> {
  for (const item of items) {
    yield await Promise.resolve(item);
  }
}

async function collect(...items: readonly ItemBundle[]): Promise<string> {
  const chunks: Uint8Array[] = [];

  for await (const chunk of writeBundleStream({
    manifest: MANIFEST,
    bundles: bundlesOf(...items),
  })) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString();
}

describe('the bundle stream', () => {
  it('writes the manifest first, so a reader has the tree before the bodies', async () => {
    const lines = (await collect(bundle('a'))).trimEnd().split('\n');

    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ format: 'nix-archive' });
  });

  it('writes one line per bundle, in the order they arrived', async () => {
    const lines = (await collect(bundle('a'), bundle('b'))).trimEnd().split('\n');

    expect(lines).toHaveLength(4);
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({ id: 'a' });
    expect(JSON.parse(lines[2] ?? '')).toMatchObject({ id: 'b' });
  });

  it('ends with a sentinel counting what it wrote', async () => {
    // Without this, a truncated stream is still a run of valid JSON lines - so a reader would
    // accept a short export as a complete one and produce a plausible, silently incomplete file.
    const lines = (await collect(bundle('a'), bundle('b'))).trimEnd().split('\n');

    expect(JSON.parse(lines[3] ?? '')).toEqual({ end: true, items: 2 });
  });

  it('counts zero for an export with no bundles rather than omitting the sentinel', async () => {
    const lines = (await collect()).trimEnd().split('\n');

    expect(JSON.parse(lines[1] ?? '')).toEqual({ end: true, items: 0 });
  });

  it('never lets document content split a line', async () => {
    // The load-bearing assumption of the whole framing: JSON.stringify escapes a newline inside a
    // string as two characters, so a document full of them still occupies exactly one line.
    const text = 'first\nsecond\nthird';
    const stream = await collect(
      bundle('a', { schemaVersion: 2, prosemirror: { type: 'doc', text } }),
    );

    const lines = stream.trimEnd().split('\n');

    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({
      body: { prosemirror: { text } },
    });
  });

  it('ends every line, so the last bundle is not left waiting for a newline', async () => {
    expect(await collect(bundle('a'))).toMatch(/\n$/);
  });
});
