import { z } from 'zod';

import { browserStorage } from './browser-storage';

/**
 * Generated thumbnails, kept on this device.
 *
 * A thumbnail made in the browser is work the browser would otherwise redo on every visit, so the
 * result is kept: in Cache Storage where there is one, in memory where there is not. The server
 * has no copy and does not need one - a thumbnail is derived state, and losing it costs one more
 * render.
 *
 * Keyed by item and by a `version` the caller chooses (a file's byte length and last-modified
 * stamp, say), so a replaced file is a different key and the old picture is never shown for it.
 * Only the newest version of an item is kept; the older ones can never be asked for again.
 *
 * **Nothing here may throw.** A private window, a blocked policy, a full disk and a quota error all
 * degrade to "no cache": a read finds nothing and a write does nothing.
 *
 * The cache's own contents cannot be listed cheaply or ordered by use, so the order lives in a
 * small index in browser storage - the same most-recent-last shape the reading-progress record
 * uses - and eviction is least-recently-used against two caps. Without browser storage the entries
 * are held in memory in a `Map`, whose insertion order is the same index.
 *
 * **The request URLs are synthetic and never fetched.** They are only names for `cache.put` and
 * `cache.match`, which do not pass through the service worker. They sit under `/__thumbnail/`,
 * which the worker's allowlist of known assets and its application-route prefixes both ignore, and
 * the cache's name does not start with `nix-pwa-`, the prefix the worker deletes on activation.
 */

const CACHE_NAME = 'nix-thumbnails-v1';
const INDEX_KEY = 'nix.thumbnails.index';
const URL_PREFIX = '/__thumbnail/';

export const THUMBNAIL_CACHE_MAX_ENTRIES = 300;
export const THUMBNAIL_CACHE_MAX_BYTES = 30 * 1024 * 1024;

export interface ThumbnailKey {
  readonly itemId: string;

  /** Anything that changes when the file does; it is only ever compared for equality. */
  readonly version: string;
}

const entrySchema = z.object({
  id: z.string().min(1),
  url: z.string().min(1),
  size: z.number().int().min(0),
});
const indexSchema = z.array(entrySchema);
type Entry = z.infer<typeof entrySchema>;

/** Most recent last, so a touch moves an entry to the end and eviction takes from the front. */
function readIndex(storage: Storage | undefined): Entry[] {
  try {
    const raw = storage?.getItem(INDEX_KEY);
    if (raw === null || raw === undefined) return [];
    const parsed = indexSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function writeIndex(storage: Storage | undefined, entries: readonly Entry[]): void {
  try {
    storage?.setItem(INDEX_KEY, JSON.stringify(entries));
  } catch {
    // Full or refused. An index that is not saved only means the next session starts it afresh.
  }
}

function requestUrl(key: ThumbnailKey): string {
  return `${URL_PREFIX}${encodeURIComponent(key.itemId)}/${encodeURIComponent(key.version)}`;
}

/** Where the bytes live. The index is kept beside it, by whoever owns the backend. */
interface Backend {
  get(url: string): Promise<Blob | null>;
  put(url: string, blob: Blob): Promise<void>;
  remove(url: string): Promise<void>;
}

const memory = new Map<string, Blob>();
const memoryBackend: Backend = {
  get: (url) => Promise.resolve(memory.get(url) ?? null),
  put: (url, blob) => {
    memory.set(url, blob);
    return Promise.resolve();
  },
  remove: (url) => {
    memory.delete(url);
    return Promise.resolve();
  },
};

function cacheStorageBackend(cache: Cache): Backend {
  return {
    get: async (url) => {
      const response = await cache.match(url);
      return response === undefined ? null : response.blob();
    },
    put: (url, blob) =>
      cache.put(url, new Response(blob, { headers: { 'Content-Type': blob.type } })),
    remove: async (url) => {
      await cache.delete(url);
    },
  };
}

interface Store {
  readonly backend: Backend;

  /** The order, per store: persisted when the bytes are, in memory when they are not. */
  readonly load: () => Entry[];
  readonly save: (entries: readonly Entry[]) => void;
}

let memoryIndex: Entry[] = [];
const memoryStore: Store = {
  backend: memoryBackend,
  load: () => memoryIndex,
  save: (entries) => {
    memoryIndex = [...entries];
  },
};

let storePromise: Promise<Store> | undefined;

/**
 * Cache Storage with its index in browser storage, or memory. Both halves are needed for the
 * first: bytes in a cache that nothing tracks would never be evicted.
 */
function openStore(): Promise<Store> {
  storePromise ??= (async (): Promise<Store> => {
    try {
      const storage = browserStorage();
      if (storage === undefined || typeof caches === 'undefined') return memoryStore;
      const cache = await caches.open(CACHE_NAME);
      return {
        backend: cacheStorageBackend(cache),
        load: () => readIndex(storage),
        save: (entries) => {
          writeIndex(storage, entries);
        },
      };
    } catch {
      return memoryStore;
    }
  })();
  return storePromise;
}

/** Writes and touches change the index; one at a time, so two cannot overwrite each other. */
let queue: Promise<unknown> = Promise.resolve();
function serialised<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work);
  queue = next.catch(() => undefined);
  return next;
}

export function readThumbnail(key: ThumbnailKey): Promise<Blob | null> {
  return serialised(async () => {
    try {
      const store = await openStore();
      const url = requestUrl(key);
      const entries = store.load();
      const found = entries.find((entry) => entry.url === url);
      if (found === undefined) return null;
      const blob = await store.backend.get(url);
      if (blob === null) {
        // Indexed but gone - the browser cleared it under pressure. Forget the record too.
        store.save(entries.filter((entry) => entry !== found));
        return null;
      }
      store.save([...entries.filter((entry) => entry !== found), found]);
      return blob;
    } catch {
      return null;
    }
  });
}

export function writeThumbnail(key: ThumbnailKey, blob: Blob): Promise<void> {
  return serialised(async () => {
    try {
      const store = await openStore();
      const url = requestUrl(key);
      const entries = store.load();
      // Older versions of this item, and an earlier copy of this one, are superseded.
      const superseded = entries.filter((entry) => entry.id === key.itemId);
      const kept = entries.filter((entry) => entry.id !== key.itemId);
      await Promise.all(superseded.map((entry) => store.backend.remove(entry.url)));
      await store.backend.put(url, blob);
      const next = [...kept, { id: key.itemId, url, size: blob.size }];
      let total = next.reduce((sum, entry) => sum + entry.size, 0);
      while (
        next.length > 1 &&
        (next.length > THUMBNAIL_CACHE_MAX_ENTRIES || total > THUMBNAIL_CACHE_MAX_BYTES)
      ) {
        const oldest = next.shift();
        if (oldest === undefined) break;
        total -= oldest.size;
        await store.backend.remove(oldest.url);
      }
      store.save(next);
    } catch {
      // No room, or no cache. The thumbnail was shown from the blob already; it is only not kept.
    }
  });
}

/** For a sign-out or a "clear local data": every thumbnail, on every backend. */
export function forgetThumbnails(): Promise<void> {
  return serialised(async () => {
    memory.clear();
    memoryIndex = [];
    try {
      browserStorage()?.removeItem(INDEX_KEY);
    } catch {
      // Nothing to clear if storage refuses.
    }
    try {
      if (typeof caches !== 'undefined') await caches.delete(CACHE_NAME);
    } catch {
      // Same: not clearable is not a failure the caller can act on.
    }
    // The open handle points at a deleted cache; the next use opens a fresh one.
    storePromise = undefined;
  });
}
