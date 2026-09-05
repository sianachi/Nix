import * as Y from 'yjs';
import { z } from 'zod';

const DB = 'nix-pending-drafts';
const STORE = 'updates';
const MAX_BYTES = 8 * 1024 * 1024;
const recordSchema = z.object({
  id: z.string(),
  scope: z.string(),
  revision: z.number().int().nonnegative(),
  update: z.instanceof(Uint8Array),
});
export type DraftRecord = z.infer<typeof recordSchema>;
export type DraftState = 'saving' | 'local' | 'synced' | 'error';
let generation = 0;
let channel: BroadcastChannel | undefined;
let database: Promise<IDBDatabase> | undefined;
function open(): Promise<IDBDatabase> {
  if (!channel && typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel('nix-draft-lifecycle');
    channel.onmessage = (event) => {
      if (event.data === 'signed-out') {
        generation += 1;
        window.dispatchEvent(new Event('nix:signed-out-elsewhere'));
      }
    };
  }
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: 'id' });
      store.createIndex('scope', 'scope');
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('Draft storage could not be opened.'));
    };
    request.onblocked = () => {
      reject(new Error('Draft storage is blocked.'));
    };
  });
  return database;
}
async function transaction<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, done: (value: T) => void) => void,
): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    let result: T;
    tx.oncomplete = () => {
      resolve(result);
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error('Draft transaction failed.'));
    };
    tx.onabort = () => {
      reject(tx.error ?? new Error('Draft write aborted.'));
    };
    run(tx.objectStore(STORE), (value) => {
      result = value;
    });
  });
}
export async function readDrafts(scope: string): Promise<DraftRecord[]> {
  return transaction('readonly', (store, done) => {
    const request = store.index('scope').getAll(scope);
    request.onsuccess = () => {
      const records = z.array(recordSchema).safeParse(request.result);
      if (
        !records.success ||
        records.data.length > 128 ||
        records.data.reduce((total, record) => total + record.update.byteLength, 0) > MAX_BYTES
      ) {
        store.transaction.abort();
        return;
      }
      done(records.data);
    };
  });
}
export async function writeDraft(record: DraftRecord): Promise<void> {
  if (record.update.byteLength > MAX_BYTES)
    throw new Error('The draft exceeds local storage limits.');
  await transaction<undefined>('readwrite', (store, done) => {
    store.put(record);
    done(undefined);
  });
}
/** Compare revisions so acknowledgement never deletes a newer edit from another tab. */
export async function acknowledgeDrafts(records: readonly DraftRecord[]): Promise<void> {
  await transaction<undefined>('readwrite', (store, done) => {
    for (const record of records) {
      const request = store.get(record.id);
      request.onsuccess = () => {
        const current = recordSchema.safeParse(request.result);
        if (current.success && current.data.revision === record.revision) store.delete(record.id);
      };
    }
    done(undefined);
  });
}
export async function clearDrafts(): Promise<void> {
  generation += 1;
  const ready = open();
  channel?.postMessage('signed-out');
  await ready;
  await transaction<undefined>('readwrite', (store, done) => {
    store.clear();
    done(undefined);
  });
}

export interface DraftJournalStore {
  read: (scope: string) => Promise<DraftRecord[]>;
  write: (record: DraftRecord) => Promise<void>;
  acknowledge: (records: readonly DraftRecord[]) => Promise<void>;
}

export interface DraftJournal {
  read: () => Promise<DraftRecord[]>;
  append: (update: Uint8Array) => void;
  snapshot: () => Promise<DraftRecord[]>;
  acknowledge: (records: readonly DraftRecord[]) => Promise<void>;
  discard: () => Promise<void>;
}
export function createDraftJournal(
  scope: string,
  onState: (state: DraftState) => void,
  store: DraftJournalStore = {
    read: readDrafts,
    write: writeDraft,
    acknowledge: acknowledgeDrafts,
  },
): DraftJournal {
  const id = `${scope}:${crypto.randomUUID()}`;
  const epoch = generation;
  let restored: DraftRecord[] = [];
  let revision = 0;
  let merged: Uint8Array | null = null;
  let chain = Promise.resolve();
  let disabled = false;
  return {
    async read(): Promise<DraftRecord[]> {
      restored = await store.read(scope);
      if (restored.length) onState('local');
      return restored;
    },
    append(update: Uint8Array): void {
      if (disabled || epoch !== generation) {
        onState('error');
        return;
      }
      if ((merged?.byteLength ?? 0) + update.byteLength > MAX_BYTES) {
        disabled = true;
        onState('error');
        return;
      }
      merged = merged === null ? update : Y.mergeUpdates([merged, update]);
      revision += 1;
      const record = { id, scope, revision, update: new Uint8Array(merged) };
      onState('saving');
      chain = chain
        .then(() => (epoch === generation ? store.write(record) : undefined))
        .then(() => {
          if (record.revision === revision) onState('local');
        })
        .catch(() => {
          onState('error');
        });
    },
    async snapshot(): Promise<DraftRecord[]> {
      await chain;
      return [...restored, ...(await store.read(scope)).filter((record) => record.id === id)];
    },
    async acknowledge(records: readonly DraftRecord[]): Promise<void> {
      await store.acknowledge(records);
      restored = restored.filter(
        (record) =>
          !records.some((acked) => acked.id === record.id && acked.revision === record.revision),
      );
      if (records.some((record) => record.id === id && record.revision === revision)) {
        merged = null;
      }
      if (merged === null && restored.length === 0) onState('synced');
    },
    async discard(): Promise<void> {
      disabled = true;
      await chain;
      await store.acknowledge(await store.read(scope));
    },
  };
}
