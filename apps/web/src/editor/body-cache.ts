import { z } from 'zod';

import { browserStorage } from '../lib/browser-storage';

/**
 * A local copy of document bodies this browser has already opened, so reopening one paints its
 * last known content immediately instead of an empty page that fills in after the WebSocket
 * handshake and sync round trip. ADR-0053 records the decision and what the copy may be trusted
 * with; this comment says what the code enforces.
 *
 * **Derived, never authoritative.** Every byte is a Yjs state the collaboration service confirmed.
 * The sync that follows reconciles both ways, which is only safe while the service never rewinds a
 * document under the same `docId` - true today (a restore and a schema migration are both forward
 * writes) and recorded in the ADR as a constraint on the service. The copy never decides access:
 * an editor mounts only after Core returned the item and its lock state, and only a body that
 * carries no lock at all is cached; reading a lock on an item removes any copy of it taken before
 * the lock was applied (`sealItemBodies`).
 *
 * **Closed unless someone is signed in.** The store answers reads and takes writes only for the
 * subject `openBodyCache` was last called with, recorded in a marker in `localStorage` - shared by
 * every tab - and checked in the same task that opens each transaction. Sign-out removes the
 * marker before it clears the records, so an editor in any tab that tries to write its copy back
 * during or after the clear is refused rather than racing it. A different person signing in on the
 * same browser clears every earlier record before their own are admitted.
 *
 * **When a copy is dropped.** When the collaboration service refuses the body - revoked (4403),
 * not visible (4404) or locked (4405) - or joins a different document than the copy came from; when
 * it is older than `MAX_AGE_MS`; when its workspace is no longer one the person can reach
 * (`pruneBodyCache`); past `MAX_RECORDS`, oldest first; and all of them at sign-out. A body whose
 * access was lost while the app was closed, in a workspace still reachable, stays until one of the
 * last three - the ADR's accepted residual risk.
 */

const DB = 'nix-document-cache';
const STORE = 'bodies';
const MAX_BYTES = 8 * 1024 * 1024;
/** Enough for a working set of recently opened pages without keeping a whole corpus on disk. */
export const MAX_RECORDS = 200;
/** A copy older than this is not worth the disk it sits on, or the exposure. */
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Who the store currently belongs to. Absent means closed. */
const SUBJECT_MARKER = 'nix.body-cache.subject';

const recordSchema = z.object({
  scope: z.string().min(1),
  docId: z.string().min(1),
  schemaVersion: z.number().int().nonnegative(),
  savedAt: z.number().nonnegative(),
  // Checked by tag rather than `instanceof`: a structured clone can come back from another realm.
  update: z
    .custom<Uint8Array>((value) => Object.prototype.toString.call(value) === '[object Uint8Array]')
    .transform((value) => new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
});

export interface BodyCacheRecord {
  readonly scope: string;
  readonly docId: string;
  readonly schemaVersion: number;
  readonly savedAt: number;
  readonly update: Uint8Array;
}

export interface BodyCacheStore {
  read: (scope: string) => Promise<BodyCacheRecord | null>;
  write: (record: BodyCacheRecord) => Promise<void>;
  discard: (scope: string) => Promise<void>;
}

let database: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: 'scope' });
      store.createIndex('savedAt', 'savedAt');
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      database = undefined;
      reject(request.error ?? new Error('Document cache could not be opened.'));
    };
    request.onblocked = () => {
      database = undefined;
      reject(new Error('Document cache is blocked.'));
    };
  });
  return database;
}

function currentSubject(): string | null {
  try {
    return browserStorage()?.getItem(SUBJECT_MARKER) ?? null;
  } catch {
    return null;
  }
}

/** One element of a scope's JSON array: 0 is the subject, 1 the workspace. */
function scopePart(scope: string, index: 0 | 1): string | null {
  try {
    const parsed: unknown = JSON.parse(scope);
    return Array.isArray(parsed) && typeof parsed[index] === 'string' ? parsed[index] : null;
  } catch {
    return null;
  }
}

/**
 * Items whose bodies this page has learned are locked. Their copies are deleted and no new one is
 * admitted for the rest of the session - including the one an editor writes as it closes, which
 * can land after the delete it raced.
 */
const sealedItems = new Set<string>();

/** The scope prefix every body of one item shares: `["subject","workspace","item",`. */
function itemPrefix(subject: string, workspaceId: string, itemId: string): string {
  return `${JSON.stringify([subject, workspaceId, itemId]).slice(0, -1)},`;
}

/** Whether the store is open for this scope's person right now, and the item is not sealed. */
function admits(scope: string): boolean {
  const subject = scopePart(scope, 0);
  if (subject === null || subject !== currentSubject()) return false;
  for (const prefix of sealedItems) if (scope.startsWith(prefix)) return false;
  return true;
}

/**
 * Runs `run` in a transaction created in the same task as the `admitted` check, so a sign-out in
 * any tab either happens before the check (and refuses this) or queues its clear after this
 * transaction - IndexedDB runs overlapping read-write transactions in creation order.
 */
async function transaction<T>(
  mode: IDBTransactionMode,
  admitted: () => boolean,
  refused: T,
  run: (store: IDBObjectStore, done: (value: T) => void) => void,
): Promise<T> {
  const db = await open();
  if (!admitted()) return refused;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    let result: T = refused;
    tx.oncomplete = () => {
      resolve(result);
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error('Document cache transaction failed.'));
    };
    tx.onabort = () => {
      reject(tx.error ?? new Error('Document cache write aborted.'));
    };
    run(tx.objectStore(STORE), (value) => {
      result = value;
    });
  });
}

const always = (): boolean => true;

export async function readBodyCache(scope: string): Promise<BodyCacheRecord | null> {
  return transaction<BodyCacheRecord | null>(
    'readonly',
    () => admits(scope),
    null,
    (store, done) => {
      const request = store.get(scope);
      request.onsuccess = () => {
        const parsed = recordSchema.safeParse(request.result);
        done(
          parsed.success &&
            parsed.data.scope === scope &&
            parsed.data.update.byteLength <= MAX_BYTES &&
            Date.now() - parsed.data.savedAt <= MAX_AGE_MS
            ? parsed.data
            : null,
        );
      };
    },
  );
}

export async function writeBodyCache(record: BodyCacheRecord): Promise<void> {
  if (record.update.byteLength > MAX_BYTES) return;
  await transaction<undefined>(
    'readwrite',
    () => admits(record.scope),
    undefined,
    (store, done) => {
      store.put(record);
      // Evict past the bound, oldest first. The cursor opens only when this write grew the store
      // past it, so refreshing a copy already held costs one count.
      const count = store.count();
      count.onsuccess = () => {
        let excess = count.result - MAX_RECORDS;
        if (excess <= 0) return;
        const cursor = store.index('savedAt').openCursor();
        cursor.onsuccess = () => {
          const current = cursor.result;
          if (current === null || excess <= 0) return;
          if (current.primaryKey !== record.scope) {
            current.delete();
            excess -= 1;
          }
          current.continue();
        };
      };
      done(undefined);
    },
  );
}

/** Forgetting is always allowed: refusing to delete is never the safe direction. */
export async function discardBodyCache(scope: string): Promise<void> {
  await transaction<undefined>('readwrite', always, undefined, (store, done) => {
    store.delete(scope);
    done(undefined);
  });
}

/**
 * Opens the store for the person now signed in. A different person than the store last belonged
 * to clears it first, so nothing one person opened is ever painted for, or readable by, the next -
 * including after a session that expired rather than being signed out of.
 */
export async function openBodyCache(subject: string): Promise<void> {
  const storage = browserStorage();
  if (storage === undefined || currentSubject() === subject) return;
  // Closed while clearing, so neither person's editors read or write in between.
  storage.removeItem(SUBJECT_MARKER);
  if (typeof indexedDB !== 'undefined') await clearRecords();
  storage.setItem(SUBJECT_MARKER, subject);
}

/** Closes the store and removes every cached body. Called on sign-out, here or in another tab. */
export async function clearBodyCache(): Promise<void> {
  try {
    browserStorage()?.removeItem(SUBJECT_MARKER);
  } catch {
    // Storage refused: the records are still cleared below, and writes check the marker anyway.
  }
  await clearRecords();
}

async function clearRecords(): Promise<void> {
  await transaction<undefined>('readwrite', always, undefined, (store, done) => {
    store.clear();
    done(undefined);
  });
}

/**
 * Removes every body copy of an item that carries a lock - note, canvas, sheet or any other body
 * path - and refuses new ones for the session. Called by the page whenever it reads a lock, open
 * or not, so a copy taken before the lock was applied does not outlive it.
 */
export async function sealItemBodies(
  subject: string,
  workspaceId: string,
  itemId: string,
): Promise<void> {
  const prefix = itemPrefix(subject, workspaceId, itemId);
  sealedItems.add(prefix);
  await transaction<undefined>('readwrite', always, undefined, (store, done) => {
    store.delete(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
    done(undefined);
  });
}

/**
 * Drops every copy that is past its age, belongs to someone else, or sits in a workspace this
 * person can no longer reach - run whenever the accessible workspace list arrives.
 */
export async function pruneBodyCache(
  subject: string,
  reachableWorkspaceIds: readonly string[],
): Promise<void> {
  const reachable = new Set(reachableWorkspaceIds);
  const oldest = Date.now() - MAX_AGE_MS;
  await transaction<undefined>('readwrite', always, undefined, (store, done) => {
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const current = cursor.result;
      if (current === null) return;
      const parsed = recordSchema.safeParse(current.value);
      const scope = typeof current.primaryKey === 'string' ? current.primaryKey : '';
      const workspace = scopePart(scope, 1);
      if (
        !parsed.success ||
        parsed.data.savedAt < oldest ||
        scopePart(scope, 0) !== subject ||
        workspace === null ||
        !reachable.has(workspace)
      ) {
        current.delete();
      }
      current.continue();
    };
    done(undefined);
  });
}

export const indexedBodyCache: BodyCacheStore = {
  read: readBodyCache,
  write: writeBodyCache,
  discard: discardBodyCache,
};

/**
 * The scope of one document body - who is reading it, where, and which body - shared by this
 * cache and the draft journal, so both stores agree on what "this person's copy" means.
 */
export function documentScope(
  subject: string | undefined,
  workspaceId: string | undefined,
  itemId: string,
  body: string,
): string | undefined {
  if (!subject || !workspaceId) return undefined;
  return JSON.stringify([subject, workspaceId, itemId, body]);
}
