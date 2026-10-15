import { Capacitor } from '@capacitor/core';

export class NoteStorageClosed extends Error {
  constructor() {
    super('This account’s note storage is closed.');
  }
}

export type NoteKey = IDBValidKey;
export type NoteQuery = IDBValidKey | IDBKeyRange | null;
export interface NoteEntry {
  readonly key: NoteKey;
  readonly primaryKey: NoteKey;
  readonly value: unknown;
}
export interface NoteIndex {
  getAll(query?: NoteQuery): Promise<unknown[]>;
  getKey(query: NoteQuery): Promise<NoteKey | undefined>;
  entries(
    query?: NoteQuery,
    direction?: IDBCursorDirection,
    keysOnly?: boolean,
  ): Promise<NoteEntry[]>;
}
export interface NoteTable extends NoteIndex {
  get(key: NoteKey): Promise<unknown>;
  put(record: unknown): Promise<void>;
  delete(query: Exclude<NoteQuery, null>): Promise<void>;
  clear(): Promise<void>;
  index(name: string): NoteIndex;
}
export interface NoteTransaction {
  table(name: string): NoteTable;
}

export const noteDatabases = {
  'nix-document-cache': {
    version: 1,
    stores: { bodies: { key: 'scope', indexes: { savedAt: 'savedAt' } } },
  },
  'nix-pending-drafts': {
    version: 2,
    stores: {
      updates: { key: 'id', indexes: { scope: 'scope' } },
      migrations: { key: 'fromScope', indexes: { toScope: 'toScope' } },
    },
  },
  'nix-offline-notes': {
    version: 1,
    stores: {
      notes: { key: 'key', indexes: { subject: 'subject' } },
      workspaces: { key: 'subject', indexes: {} },
    },
  },
  'nix-offline-note-assets': {
    version: 1,
    stores: {
      assets: {
        key: 'key',
        indexes: { scope: 'scope', version: ['scope', 'fileItemId', 'sha256'] },
      },
    },
  },
} satisfies Record<
  string,
  {
    version: number;
    stores: Record<string, { key: string; indexes: Record<string, string | string[]> }>;
  }
>;
export type NoteDatabaseName = keyof typeof noteDatabases;
export interface NoteStoreDefinition {
  key: string;
  indexes: Record<string, string | string[]>;
}
const databases = new Map<NoteDatabaseName, Promise<IDBDatabase>>();
function openBrowser(name: NoteDatabaseName): Promise<IDBDatabase> {
  let opening = databases.get(name);
  if (opening !== undefined) return opening;
  opening = new Promise((resolve, reject) => {
    const definition = noteDatabases[name];
    const request = indexedDB.open(name, definition.version);
    request.onupgradeneeded = () => {
      for (const [storeName, store] of Object.entries(definition.stores)) {
        if (request.result.objectStoreNames.contains(storeName)) continue;
        const created = request.result.createObjectStore(storeName, { keyPath: store.key });
        for (const [index, path] of Object.entries(store.indexes)) created.createIndex(index, path);
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close();
        databases.delete(name);
      };
      resolve(request.result);
    };
    request.onerror = () => {
      databases.delete(name);
      reject(request.error ?? new Error('Note storage could not be opened.'));
    };
    request.onblocked = () => {
      databases.delete(name);
      reject(new Error('Note storage is blocked by another app window.'));
    };
  });
  databases.set(name, opening);
  void opening.catch(() => {
    if (databases.get(name) === opening) databases.delete(name);
  });
  return opening;
}
function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('Note storage failed.'));
    };
  });
}
function browserIndex(source: IDBObjectStore | IDBIndex): NoteIndex {
  return {
    getAll: (query) => result(source.getAll(query)),
    getKey: (query) => result(source.getKey(query ?? IDBKeyRange.lowerBound(''))),
    entries: (query, direction, keysOnly) =>
      new Promise((resolve, reject) => {
        const entries: NoteEntry[] = [];
        const request = keysOnly
          ? source.openKeyCursor(query, direction)
          : source.openCursor(query, direction);
        request.onerror = () => {
          reject(request.error ?? new Error('Note storage scan failed.'));
        };
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor === null) {
            resolve(entries);
            return;
          }
          entries.push({
            key: cursor.key,
            primaryKey: cursor.primaryKey,
            value: 'value' in cursor ? cursor.value : undefined,
          });
          cursor.continue();
        };
      }),
  };
}
function browserTable(store: IDBObjectStore): NoteTable {
  return {
    ...browserIndex(store),
    get: (key) => result(store.get(key)),
    put: async (record) => {
      await result(store.put(record));
    },
    delete: async (query) => {
      await result(store.delete(query));
    },
    clear: async () => {
      await result(store.clear());
    },
    index: (name) => browserIndex(store.index(name)),
  };
}
export async function noteTransaction<T>(
  name: NoteDatabaseName,
  stores: string | string[],
  mode: IDBTransactionMode,
  admitted: () => boolean,
  run: (transaction: NoteTransaction) => Promise<T>,
): Promise<T> {
  if (Capacitor.isNativePlatform()) {
    const { sqliteNoteTransaction } = await import('./sqlite-note-database');
    return sqliteNoteTransaction(name, stores, mode, admitted, run);
  }
  const db = await openBrowser(name);
  if (!admitted()) throw new NoteStorageClosed();
  const tx = db.transaction(stores, mode);
  const complete = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = tx.onabort = () => {
      reject(tx.error ?? new Error('Note storage transaction failed.'));
    };
  });
  // Handle an early abort even while the callback is still awaiting a request.
  void complete.catch(() => undefined);
  try {
    const value = await run({ table: (store) => browserTable(tx.objectStore(store)) });
    if (!admitted()) throw new NoteStorageClosed();
    await complete;
    if (!admitted()) throw new NoteStorageClosed();
    return value;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      /* The transaction may have already aborted. */
    }
    await complete.catch(() => undefined);
    throw error;
  }
}
