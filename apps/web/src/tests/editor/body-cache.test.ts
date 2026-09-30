import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearBodyCache,
  documentScope,
  MAX_AGE_MS,
  MAX_RECORDS,
  openBodyCache,
  pruneBodyCache,
  sealItemBodies,
  readBodyCache,
  writeBodyCache,
  type BodyCacheRecord,
} from '../../editor/body-cache';

const ADA = 'subject-ada';
const BO = 'subject-bo';

function scope(subject: string, item: string, workspace = 'workspace-1'): string {
  const value = documentScope(subject, workspace, item, 'note');
  if (value === undefined) throw new Error('No scope.');
  return value;
}

function record(forScope: string, savedAt = Date.now(), bytes = 4): BodyCacheRecord {
  return {
    scope: forScope,
    docId: `doc-${forScope}`,
    schemaVersion: 1,
    savedAt,
    update: new Uint8Array(bytes),
  };
}

/** The marker naming who the store belongs to lives in localStorage, shared by every tab. */
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => {
      values.clear();
    },
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

beforeEach(async () => {
  vi.stubGlobal('localStorage', memoryStorage());
  await clearBodyCache();
  await openBodyCache(ADA);
});

describe('the document body store', () => {
  it('reads back what it wrote, for the same scope only', async () => {
    await writeBodyCache(record(scope(ADA, 'a')));

    expect((await readBodyCache(scope(ADA, 'a')))?.docId).toBe(`doc-${scope(ADA, 'a')}`);
    expect(await readBodyCache(scope(ADA, 'b'))).toBeNull();
  });

  it('keeps at most its bound, evicting the least recently saved first', async () => {
    const now = Date.now();
    for (let index = 0; index <= MAX_RECORDS; index += 1) {
      await writeBodyCache(record(scope(ADA, `item-${String(index)}`), now - MAX_RECORDS + index));
    }

    expect(await readBodyCache(scope(ADA, 'item-0'))).toBeNull();
    expect(await readBodyCache(scope(ADA, 'item-1'))).not.toBeNull();
    expect(await readBodyCache(scope(ADA, `item-${String(MAX_RECORDS)}`))).not.toBeNull();
  });

  it('refuses a body larger than the per-document limit', async () => {
    await writeBodyCache(record(scope(ADA, 'huge'), Date.now(), 8 * 1024 * 1024 + 1));

    expect(await readBodyCache(scope(ADA, 'huge'))).toBeNull();
  });

  it('does not hand back a copy older than the age limit', async () => {
    await writeBodyCache(record(scope(ADA, 'old'), Date.now() - MAX_AGE_MS - 1));

    expect(await readBodyCache(scope(ADA, 'old'))).toBeNull();
  });

  it('is closed after sign-out: nothing to read, and a late write is refused', async () => {
    await writeBodyCache(record(scope(ADA, 'a')));
    await clearBodyCache();

    // An editor still mounted in this or another tab tries to put its copy back.
    await writeBodyCache(record(scope(ADA, 'late')));
    await openBodyCache(ADA);

    expect(await readBodyCache(scope(ADA, 'a'))).toBeNull();
    expect(await readBodyCache(scope(ADA, 'late'))).toBeNull();
  });

  it('never serves or keeps one person’s copies for the next person to sign in', async () => {
    await writeBodyCache(record(scope(ADA, 'a')));
    await openBodyCache(BO);

    await writeBodyCache(record(scope(ADA, 'b')));
    expect(await readBodyCache(scope(ADA, 'a'))).toBeNull();
    expect(await readBodyCache(scope(ADA, 'b'))).toBeNull();

    // Ada signing back in finds nothing of hers either: the store was cleared for Bo.
    await openBodyCache(ADA);
    expect(await readBodyCache(scope(ADA, 'a'))).toBeNull();
  });

  it('prunes copies in workspaces the person can no longer reach', async () => {
    await writeBodyCache(record(scope(ADA, 'kept', 'workspace-1')));
    await writeBodyCache(record(scope(ADA, 'gone', 'workspace-2')));

    await pruneBodyCache(ADA, ['workspace-1']);

    expect(await readBodyCache(scope(ADA, 'kept', 'workspace-1'))).not.toBeNull();
    expect(await readBodyCache(scope(ADA, 'gone', 'workspace-2'))).toBeNull();
  });

  it('removes every copy of a locked item and refuses new ones, leaving other items alone', async () => {
    const note = scope(ADA, 'locked-item');
    const canvas = documentScope(ADA, 'workspace-1', 'locked-item', 'canvas') ?? '';
    const neighbour = scope(ADA, 'locked-item-2');
    await writeBodyCache(record(note));
    await writeBodyCache(record(canvas));
    await writeBodyCache(record(neighbour));

    await sealItemBodies(ADA, 'workspace-1', 'locked-item');
    // The editor that was showing it writes its copy as it closes, after the seal.
    await writeBodyCache(record(note));

    expect(await readBodyCache(note)).toBeNull();
    expect(await readBodyCache(canvas)).toBeNull();
    expect(await readBodyCache(neighbour)).not.toBeNull();
  });

  it('stays closed where the browser offers no storage to record whose it is', async () => {
    vi.stubGlobal('localStorage', undefined);
    await openBodyCache(ADA);
    await writeBodyCache(record(scope(ADA, 'a')));

    vi.stubGlobal('localStorage', memoryStorage());
    await openBodyCache(ADA);
    expect(await readBodyCache(scope(ADA, 'a'))).toBeNull();
  });

  it('scopes a copy to the signed-in person and workspace, and has none without them', () => {
    expect(documentScope('person', 'workspace', 'item', 'note')).toBe(
      JSON.stringify(['person', 'workspace', 'item', 'note']),
    );
    expect(documentScope(undefined, 'workspace', 'item', 'note')).toBeUndefined();
    expect(documentScope('person', undefined, 'item', 'note')).toBeUndefined();
  });
});
