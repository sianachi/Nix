import { memoryStorage } from '../helpers/memory-storage';
import 'fake-indexeddb/auto';
import { DatabaseSync } from 'node:sqlite';
import { Capacitor } from '@capacitor/core';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
const native = vi.hoisted(() => ({
  open: vi.fn(),
  execute: vi.fn(),
  run: vi.fn(),
  query: vi.fn(),
  beginTransaction: vi.fn(),
  commitTransaction: vi.fn(),
  rollbackTransaction: vi.fn(),
}));
vi.mock('@capacitor-community/sqlite', () => ({
  CapacitorSQLite: {},
  SQLiteConnection: class {
    checkConnectionsConsistency() {
      return Promise.resolve({ result: true });
    }
    isConnection() {
      return Promise.resolve({ result: false });
    }
    createConnection() {
      return Promise.resolve(native);
    }
  },
}));
import type { NoteSqlite } from '../../lib/sqlite-note-database';
import {
  openBodyCache,
  clearBodyCache,
  documentScope,
  readBodyCache,
  writeBodyCache,
} from '../../editor/body-cache';
import {
  writeDraft,
  readDrafts,
  acknowledgeDrafts,
  clearDrafts,
  migrateLocalDrafts,
} from '../../editor/draft-journal';
import {
  rememberOfflineAccount,
  saveOfflineNote,
  loadOfflineNotes,
  getOfflineSnapshot,
  clearOfflineData,
} from '../../offline/offline-store';

let db: DatabaseSync;
beforeEach(async () => {
  vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
  vi.stubGlobal('localStorage', memoryStorage());
  db = new DatabaseSync(':memory:');
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
  native.open.mockResolvedValue(undefined);
  native.execute.mockImplementation(driver.execute);
  native.run.mockImplementation(driver.run);
  native.query.mockImplementation(driver.query);
  native.beginTransaction.mockImplementation(driver.beginTransaction);
  native.commitTransaction.mockImplementation(driver.commitTransaction);
  native.rollbackTransaction.mockImplementation(driver.rollbackTransaction);
  await openBodyCache('alice', { reauthorized: true });
  await rememberOfflineAccount({ subject: 'alice', name: 'Alice', email: null });
});
afterEach(async () => {
  await clearDrafts();
  await clearBodyCache();
  await clearOfflineData();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  db.close();
});
function noteScope(itemId = 'note'): string {
  const value = documentScope('alice', 'workspace', itemId, 'note');
  if (value === undefined) throw new Error('Missing note scope.');
  return value;
}
const scope = () => noteScope();
function update(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('note').insert(0, text);
  const bytes = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return bytes;
}
it('uses native SQLite for the actual offline metadata, confirmed body and pending journal paths', async () => {
  await saveOfflineNote({
    id: 'note',
    workspaceId: 'workspace',
    parentId: null,
    title: 'An offline note',
    canWrite: true,
    bodyAvailable: true,
    publication: { kind: 'published', serverId: 'note', docId: 'document' },
    pendingTitle: null,
    blockedReason: null,
  });
  const bytes = update('Written and retained offline');
  await writeBodyCache({
    scope: scope(),
    docId: 'document',
    schemaVersion: 1,
    savedAt: 1,
    update: bytes,
  });
  const draft = { id: 'draft', scope: scope(), revision: 1, docId: 'document', update: bytes };
  await writeDraft(draft);
  await writeDraft({ ...draft, revision: 2 });
  await acknowledgeDrafts([draft]);
  expect((await readDrafts(scope())).map((record) => record.revision)).toEqual([2]);
  expect((await readBodyCache(scope()))?.update).toEqual(bytes);
  await loadOfflineNotes();
  expect(getOfflineSnapshot().notes.map((note) => note.title)).toEqual(['An offline note']);
  expect(
    db
      .prepare('SELECT database_name FROM note_records ORDER BY database_name')
      .all()
      .map((row) => row.database_name),
  ).toEqual(['nix-document-cache', 'nix-offline-notes', 'nix-pending-drafts']);
});
it('publishes a local note once and redirects late edits through the same SQLite transaction', async () => {
  const source = noteScope('local');
  const target = noteScope('published');
  const bytes = update('Local creation');
  await writeBodyCache({
    scope: source,
    docId: 'local:local',
    schemaVersion: 1,
    savedAt: 1,
    update: bytes,
  });
  await writeDraft({
    id: 'draft',
    scope: source,
    revision: 1,
    docId: 'local:local',
    update: bytes,
  });
  await migrateLocalDrafts(source, target, { createdItemId: 'published' });
  await migrateLocalDrafts(source, target, { createdItemId: 'published' });
  await writeDraft({ id: 'late', scope: source, revision: 2, docId: 'local:local', update: bytes });
  expect(await readDrafts(source)).toEqual([]);
  expect((await readDrafts(target)).map((record) => record.id).sort()).toEqual(
    [`${target}:published-local`, 'late'].sort(),
  );
});
it('does not expose another account after switching or permit a late old-account write', async () => {
  await writeBodyCache({
    scope: scope(),
    docId: 'document',
    schemaVersion: 1,
    savedAt: 1,
    update: update('Private'),
  });
  await openBodyCache('bob', { reauthorized: true });
  await rememberOfflineAccount({ subject: 'bob', name: 'Bob', email: null });
  expect(await readBodyCache(scope())).toBeNull();
  await expect(
    writeDraft({ id: 'late', scope: scope(), revision: 1, update: update('late') }),
  ).rejects.toThrow();
  expect(await readDrafts(scope())).toEqual([]);
  expect(
    db
      .prepare(
        "SELECT count(*) AS count FROM note_records WHERE database_name = 'nix-document-cache'",
      )
      .get()?.count,
  ).toBe(0);
});
