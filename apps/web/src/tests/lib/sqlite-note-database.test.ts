// @vitest-environment node
import 'fake-indexeddb/auto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createSqliteNoteStorage, type NoteSqlite } from '../../lib/sqlite-note-database';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'nix-capacitor-sqlite-'));
  let db = new DatabaseSync(join(root, 'notes.sqlite'));
  db.exec(
    'CREATE TABLE note_records(database_name TEXT NOT NULL, store_name TEXT NOT NULL, key TEXT NOT NULL, indexes TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(database_name, store_name, key))',
  );
  const driver: NoteSqlite = {
    execute: (sql) => {
      db.exec(sql);
      return Promise.resolve();
    },
    run: (sql, values) => Promise.resolve(db.prepare(sql).run(...(values ?? []).map(String))),
    query: (sql, values) =>
      Promise.resolve({ values: db.prepare(sql).all(...(values ?? []).map(String)) }),
    beginTransaction: () => {
      db.exec('BEGIN IMMEDIATE');
      return Promise.resolve();
    },
    commitTransaction: () => {
      db.exec('COMMIT');
      return Promise.resolve();
    },
    rollbackTransaction: () => {
      db.exec('ROLLBACK');
      return Promise.resolve();
    },
  };
  const storage = createSqliteNoteStorage(() => Promise.resolve(driver));
  cleanups.push(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    ...storage,
    reopen: () => {
      db.close();
      db = new DatabaseSync(join(root, 'notes.sqlite'));
    },
  };
}
const admitted = () => true;
describe('native SQLite note storage', () => {
  it('recovers exact Yjs note bytes and pending edits after closing the database', async () => {
    const store = await fixture();
    const doc = new Y.Doc();
    doc.getText('note').insert(0, 'Written offline');
    const update = Y.encodeStateAsUpdate(doc);
    await store.transaction('nix-document-cache', 'bodies', 'readwrite', admitted, async (tx) => {
      await tx.table('bodies').put({ scope: 'alice:note', savedAt: 1, update });
    });
    await store.transaction('nix-pending-drafts', 'updates', 'readwrite', admitted, async (tx) => {
      await tx.table('updates').put({ id: 'draft-1', scope: 'alice:note', revision: 1, update });
    });
    store.reopen();
    const body = await store.transaction(
      'nix-document-cache',
      'bodies',
      'readonly',
      admitted,
      (tx) => tx.table('bodies').get('alice:note'),
    );
    expect(body).toEqual({ scope: 'alice:note', savedAt: 1, update });
    const drafts = await store.transaction(
      'nix-pending-drafts',
      'updates',
      'readonly',
      admitted,
      (tx) => tx.table('updates').index('scope').getAll('alice:note'),
    );
    expect(drafts).toEqual([{ id: 'draft-1', scope: 'alice:note', revision: 1, update }]);
    doc.destroy();
  });
  it('rolls back every write when account admission changes before commit', async () => {
    const store = await fixture();
    let current = true;
    await expect(
      store.transaction(
        'nix-pending-drafts',
        ['updates', 'migrations'],
        'readwrite',
        () => current,
        async (tx) => {
          await tx
            .table('updates')
            .put({ id: 'draft', scope: 'alice', update: new Uint8Array([1]) });
          await tx.table('migrations').put({ fromScope: 'alice', toScope: 'published' });
          current = false;
        },
      ),
    ).rejects.toThrow('storage is closed');
    expect(
      await store.transaction('nix-pending-drafts', 'updates', 'readonly', admitted, (tx) =>
        tx.table('updates').getAll(),
      ),
    ).toEqual([]);
    expect(
      await store.transaction('nix-pending-drafts', 'migrations', 'readonly', admitted, (tx) =>
        tx.table('migrations').getAll(),
      ),
    ).toEqual([]);
  });
  it('serializes overlapping read-modify-write operations without losing newer revisions', async () => {
    const store = await fixture();
    await store.transaction('nix-pending-drafts', 'updates', 'readwrite', admitted, (tx) =>
      tx.table('updates').put({ id: 'draft', scope: 'alice', revision: 0 }),
    );
    await Promise.all(
      Array.from({ length: 8 }, () =>
        store.transaction('nix-pending-drafts', 'updates', 'readwrite', admitted, async (tx) => {
          const record = await tx.table('updates').get('draft');
          if (
            record === null ||
            typeof record !== 'object' ||
            !('revision' in record) ||
            typeof record.revision !== 'number'
          )
            throw new Error('Missing revision');
          await tx.table('updates').put({ ...record, revision: record.revision + 1 });
        }),
      ),
    );
    expect(
      await store.transaction('nix-pending-drafts', 'updates', 'readonly', admitted, (tx) =>
        tx.table('updates').get('draft'),
      ),
    ).toEqual({ id: 'draft', scope: 'alice', revision: 8 });
  });
  it('deletes only the named account range and can continue after rollback', async () => {
    const store = await fixture();
    await store.transaction('nix-document-cache', 'bodies', 'readwrite', admitted, async (tx) => {
      await tx.table('bodies').put({ scope: '["alice","note"]', savedAt: 1 });
      await tx.table('bodies').put({ scope: '["bob","note"]', savedAt: 2 });
    });
    await expect(
      store.transaction('nix-document-cache', 'bodies', 'readwrite', admitted, async (tx) => {
        await tx.table('bodies').clear();
        throw new Error('Disk failed');
      }),
    ).rejects.toThrow('Disk failed');
    await store.transaction('nix-document-cache', 'bodies', 'readwrite', admitted, (tx) =>
      tx.table('bodies').delete(IDBKeyRange.bound('["alice",', '["alice",\uffff')),
    );
    expect(
      await store.transaction('nix-document-cache', 'bodies', 'readonly', admitted, (tx) =>
        tx.table('bodies').getAll(),
      ),
    ).toEqual([{ scope: '["bob","note"]', savedAt: 2 }]);
  });
  it('uses compound asset version keys and restores exact binary image bytes', async () => {
    const store = await fixture();
    const bytes = new Uint8Array([0, 128, 255, 1]);
    await store.transaction('nix-offline-note-assets', 'assets', 'readwrite', admitted, (tx) =>
      tx.table('assets').put({
        key: 'asset',
        scope: 'alice',
        fileItemId: 'image',
        sha256: 'hash',
        blob: new Blob([bytes], { type: 'image/png' }),
      }),
    );
    store.reopen();
    expect(
      await store.transaction('nix-offline-note-assets', 'assets', 'readonly', admitted, (tx) =>
        tx.table('assets').index('version').getKey(['alice', 'image', 'hash']),
      ),
    ).toBe('asset');
    const asset = await store.transaction(
      'nix-offline-note-assets',
      'assets',
      'readonly',
      admitted,
      (tx) => tx.table('assets').get('asset'),
    );
    if (
      asset === null ||
      typeof asset !== 'object' ||
      !('blob' in asset) ||
      !(asset.blob instanceof Blob)
    )
      throw new Error('Missing image');
    expect(asset.blob.type).toBe('image/png');
    expect(new Uint8Array(await asset.blob.arrayBuffer())).toEqual(bytes);
  });
  it('rejects writes through read-only transactions', async () => {
    const store = await fixture();
    await expect(
      store.transaction('nix-document-cache', 'bodies', 'readonly', admitted, (tx) =>
        tx.table('bodies').put({ scope: 'note', savedAt: 1 }),
      ),
    ).rejects.toThrow('read-only');
    expect(
      await store.transaction('nix-document-cache', 'bodies', 'readonly', admitted, (tx) =>
        tx.table('bodies').getAll(),
      ),
    ).toEqual([]);
  });
  it('lists keys by saved time without returning note bodies', async () => {
    const store = await fixture();
    await store.transaction('nix-document-cache', 'bodies', 'readwrite', admitted, async (tx) => {
      await tx.table('bodies').put({ scope: 'older', savedAt: 2, update: new Uint8Array([1]) });
      await tx.table('bodies').put({ scope: 'newer', savedAt: 10, update: new Uint8Array([2]) });
    });
    expect(
      await store.transaction('nix-document-cache', 'bodies', 'readonly', admitted, (tx) =>
        tx.table('bodies').index('savedAt').entries(null, 'prev', true),
      ),
    ).toEqual([
      { key: 10, primaryKey: 'newer', value: undefined },
      { key: 2, primaryKey: 'older', value: undefined },
    ]);
  });
});
