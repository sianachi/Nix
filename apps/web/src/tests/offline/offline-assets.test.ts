import 'fake-indexeddb/auto';
import { Blob as BufferBlob } from 'node:buffer';
import {
  createNixClient,
  files,
  locks,
  NixApiError,
  type ItemLock,
  type NixClient,
} from '@nix/api-client';
import { nixSchema } from '@nix/editor-schema';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { prosemirrorJSONToYDoc } from 'y-prosemirror';
import * as Y from 'yjs';

import {
  bodyCacheAccountAdmits,
  bodyCacheAccountEpoch,
  clearBodyCache,
  discardBodyCache,
  documentScope,
  openBodyCache,
  sealItemBodies,
} from '../../editor/body-cache';
import { FRAGMENT_NAME } from '../../editor/collab-sync';
import { clearDrafts, readDrafts, writeDraft } from '../../editor/draft-journal';
import {
  cacheOfflineNoteAssets,
  clearOfflineNoteAssets,
  readOfflineNoteAsset,
} from '../../offline/offline-assets';

const SUBJECT = 'offline-assets-alice';
const WORKSPACE = '00000000-0000-4000-8000-000000000001';
const FILE = '00000000-0000-4000-8000-000000000002';
const NOTE = '00000000-0000-4000-8000-000000000003';
const SHA = 'a'.repeat(64);
const ASSET_SUBJECT_MARKER = 'nix.offline-note-assets.subject';
const REFUSED_PREFIX = 'nix.offline-note-assets.refused:';
const refusalMarker = (fileItemId: string): string =>
  `${REFUSED_PREFIX}${JSON.stringify([SUBJECT, fileItemId])}`;
const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const client = createNixClient({
  baseUrl: 'https://nix.example.test',
  tokens: {
    getAccessToken: () => Promise.resolve(null),
    refreshAccessToken: () => Promise.resolve(null),
  },
});
const documents = new Set<Y.Doc>();
let queryMock: MockInstance<NixClient['query']>;
let itemLock: ItemLock;
let currentCapability: Awaited<ReturnType<typeof files.fetchFileContent>>['capability'];

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

function noteScope(itemId = NOTE, workspaceId = WORKSPACE): string {
  const scope = documentScope(SUBJECT, workspaceId, itemId, 'note');
  if (scope === undefined) throw new Error('Missing test note scope.');
  return scope;
}

function document(fileIds: readonly string[] = [FILE]): Y.Doc {
  const doc = prosemirrorJSONToYDoc(
    nixSchema,
    {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'An offline note with images' }] },
        ...fileIds.map((fileItemId) => ({
          type: 'image',
          attrs: {
            fileItemId,
            src: null,
            alt: 'Saved image',
            title: null,
            width: null,
            height: null,
          },
        })),
      ],
    },
    FRAGMENT_NAME,
  );
  documents.add(doc);
  return doc;
}

function download({
  bytes = imageBytes,
  sha = SHA,
}: { readonly bytes?: Uint8Array; readonly sha?: string } = {}): Awaited<
  ReturnType<typeof files.fetchFileContent>
> {
  return {
    blob: new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
    capability: {
      url: 'https://objects.example.test/image?capability=temporary',
      expiresAt: '2026-10-11T12:00:00Z',
      fileName: 'image.png',
      mediaType: 'image/png',
      byteLength: bytes.byteLength,
      sha256: sha,
      inline: true,
      unscanned: true,
      noSniff: true,
    },
  };
}

function openAssetDatabase(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('nix-offline-note-assets', 1);
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('The test asset database could not be opened.'));
    };
  });
}

async function seedAsset(scope: string, fileItemId: string): Promise<void> {
  const db = await openAssetDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('assets', 'readwrite');
      tx.objectStore('assets').put({
        key: JSON.stringify([scope, fileItemId]),
        scope,
        fileItemId,
        sha256: SHA,
        mediaType: 'image/png',
        blob: download().blob,
      });
      tx.oncomplete = () => {
        resolve();
      };
      tx.onerror = () => {
        reject(tx.error ?? new Error('The test image could not be seeded.'));
      };
      tx.onabort = () => {
        reject(tx.error ?? new Error('The test image seed was aborted.'));
      };
    });
  } finally {
    db.close();
  }
}

async function storedAssets(): Promise<unknown[]> {
  const db = await openAssetDatabase();
  try {
    return await new Promise<unknown[]>((resolve, reject) => {
      const tx = db.transaction('assets', 'readonly');
      const request = tx.objectStore('assets').getAll();
      request.onsuccess = () => {
        resolve(request.result);
      };
      tx.onerror = () => {
        reject(tx.error ?? new Error('The test asset database could not be read.'));
      };
    });
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('Blob', BufferBlob);
  await clearBodyCache();
  await clearOfflineNoteAssets();
  await clearDrafts();
  await openBodyCache(SUBJECT);
  itemLock = {
    locked: false,
    unlockedUntil: null,
    lockItemId: null,
    selfLocked: false,
  };
  currentCapability = download().capability;
  queryMock = vi.spyOn(client, 'query').mockImplementation((endpoint) => {
    if (endpoint.operation === 'locks.get') return Promise.resolve(endpoint.schema.parse(itemLock));
    if (endpoint.operation === 'files.download')
      return Promise.resolve(endpoint.schema.parse(currentCapability));
    throw new Error(`Unexpected offline image query: ${endpoint.operation}`);
  });
  vi.spyOn(files, 'fetchFileContent').mockResolvedValue(download());
});

afterEach(() => {
  for (const doc of documents) doc.destroy();
  documents.clear();
  vi.restoreAllMocks();
});

describe('offline note images', () => {
  it('downloads each file once through Core and stores capability bytes in its note scope', async () => {
    const signal = new AbortController().signal;
    await cacheOfflineNoteAssets(document([FILE, FILE]), SUBJECT, WORKSPACE, NOTE, client, signal);

    expect(queryMock).toHaveBeenCalledWith(locks.getItemLock(FILE), {
      signal,
      forceRefresh: true,
    });
    expect(files.fetchFileContent).toHaveBeenCalledExactlyOnceWith(
      client,
      FILE,
      undefined,
      true,
      signal,
    );
    const stored = await storedAssets();
    expect(stored).toMatchObject([
      {
        key: JSON.stringify([noteScope(), FILE]),
        scope: noteScope(),
        fileItemId: FILE,
        sha256: SHA,
        mediaType: 'image/png',
      },
    ]);
    expect(stored[0]).toHaveProperty('blob');
    expect(stored[0]).not.toHaveProperty('bytes');

    vi.mocked(files.fetchFileContent).mockRejectedValue(new Error('Network is offline'));
    const saved = await readOfflineNoteAsset(noteScope(), FILE);
    expect(saved).toBeInstanceOf(BufferBlob);
    expect(saved?.type).toBe('image/png');
    expect(saved === null ? null : Array.from(new Uint8Array(await saved.arrayBuffer()))).toEqual(
      Array.from(imageBytes),
    );
    expect(files.fetchFileContent).toHaveBeenCalledTimes(1);
  });

  it('does not expose a downloaded file through a different note or workspace', async () => {
    await cacheOfflineNoteAssets(document(), SUBJECT, WORKSPACE, NOTE, client);

    expect(await readOfflineNoteAsset(noteScope('different-note'), FILE)).toBeNull();
    expect(await readOfflineNoteAsset(noteScope(NOTE, 'different-workspace'), FILE)).toBeNull();
    expect(await readOfflineNoteAsset(noteScope(), 'different-file')).toBeNull();
    expect(await readOfflineNoteAsset(noteScope(), FILE)).not.toBeNull();
  });

  it('forgets image bytes when another account opens the body store', async () => {
    await cacheOfflineNoteAssets(document(), SUBJECT, WORKSPACE, NOTE, client);
    await openBodyCache('offline-assets-bob');

    expect(await readOfflineNoteAsset(noteScope(), FILE)).toBeNull();
    expect(await storedAssets()).toEqual([]);
    await openBodyCache(SUBJECT);
    expect(await readOfflineNoteAsset(noteScope(), FILE)).toBeNull();
  });

  it.each(['seal', 'clear'])(
    'rejects an in-flight image download after a body %s',
    async (action) => {
      let finish: (result: Awaited<ReturnType<typeof files.fetchFileContent>>) => void = () => {
        throw new Error('The test did not begin its image download.');
      };
      const pending = new Promise<Awaited<ReturnType<typeof files.fetchFileContent>>>((resolve) => {
        finish = resolve;
      });
      vi.mocked(files.fetchFileContent).mockReturnValue(pending);
      const saving = cacheOfflineNoteAssets(
        document(),
        SUBJECT,
        WORKSPACE,
        `${NOTE}-${action}`,
        client,
      );
      const outcome = saving.then(
        () => null,
        (cause: unknown) => cause,
      );
      await vi.waitFor(() => {
        expect(files.fetchFileContent).toHaveBeenCalledOnce();
      });

      if (action === 'seal') await sealItemBodies(SUBJECT, WORKSPACE, `${NOTE}-${action}`);
      else await clearBodyCache();
      finish(download());

      expect(await outcome).toMatchObject({ message: 'This note is no longer available offline.' });
      expect(await readOfflineNoteAsset(noteScope(`${NOTE}-${action}`), FILE)).toBeNull();
      expect(await storedAssets()).toEqual([]);
    },
  );

  it('reports a quota failure and does not claim the image is available offline', async () => {
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('Offline image storage is full.', 'QuotaExceededError');
    });

    await expect(
      cacheOfflineNoteAssets(document(), SUBJECT, WORKSPACE, NOTE, client),
    ).rejects.toThrow('Offline image storage is full.');
    expect(await readOfflineNoteAsset(noteScope(), FILE)).toBeNull();
  });

  it('removes a previously cached file when Core says it carries a password lock', async () => {
    await cacheOfflineNoteAssets(document(), SUBJECT, WORKSPACE, NOTE, client);
    itemLock = {
      locked: true,
      unlockedUntil: '2026-10-11T12:00:00Z',
      lockItemId: FILE,
      selfLocked: true,
    };
    vi.mocked(files.fetchFileContent).mockClear();

    await expect(
      cacheOfflineNoteAssets(document(), SUBJECT, WORKSPACE, NOTE, client),
    ).rejects.toThrow('password-protected image');
    expect(files.fetchFileContent).not.toHaveBeenCalled();
    expect(await readOfflineNoteAsset(noteScope(), FILE)).toBeNull();
  });

  it('removes images that no longer occur in the note body', async () => {
    await cacheOfflineNoteAssets(document(), SUBJECT, WORKSPACE, NOTE, client);
    await cacheOfflineNoteAssets(document([]), SUBJECT, WORKSPACE, NOTE, client);

    expect(await readOfflineNoteAsset(noteScope(), FILE)).toBeNull();
  });

  it('forgets its cached images when the note body is discarded', async () => {
    await cacheOfflineNoteAssets(document(), SUBJECT, WORKSPACE, NOTE, client);
    await discardBodyCache(noteScope());

    expect(await readOfflineNoteAsset(noteScope(), FILE)).toBeNull();
    expect(await storedAssets()).toEqual([]);
  });

  it('forgets cached bytes if the image becomes password-protected while downloading', async () => {
    await cacheOfflineNoteAssets(document(), SUBJECT, WORKSPACE, NOTE, client);
    const changed = download({ sha: 'b'.repeat(64) });
    currentCapability = changed.capability;
    vi.mocked(files.fetchFileContent).mockImplementation(() => {
      itemLock = {
        locked: true,
        unlockedUntil: null,
        lockItemId: FILE,
        selfLocked: true,
      };
      return Promise.resolve(changed);
    });

    await expect(
      cacheOfflineNoteAssets(document(), SUBJECT, WORKSPACE, NOTE, client),
    ).rejects.toThrow('password-protected image');
    expect(await readOfflineNoteAsset(noteScope(), FILE)).toBeNull();
  });

  it('forgets a referenced file image when that file item is sealed', async () => {
    const fileItemId = '00000000-0000-4000-8000-000000000004';
    const otherWorkspace = '00000000-0000-4000-8000-000000000005';
    await cacheOfflineNoteAssets(document([fileItemId]), SUBJECT, WORKSPACE, NOTE, client);
    await cacheOfflineNoteAssets(document([fileItemId]), SUBJECT, otherWorkspace, NOTE, client);
    await sealItemBodies(SUBJECT, WORKSPACE, fileItemId);

    expect(await readOfflineNoteAsset(noteScope(), fileItemId)).toBeNull();
    expect(await readOfflineNoteAsset(noteScope(NOTE, otherWorkspace), fileItemId)).toBeNull();
    expect(await storedAssets()).toEqual([]);
  });

  it.each(['locked', 'forbidden'])(
    'forgets all references when Core reports an image is %s',
    async (failure) => {
      const otherWorkspace = '00000000-0000-4000-8000-000000000005';
      await cacheOfflineNoteAssets(document(), SUBJECT, WORKSPACE, NOTE, client);
      await cacheOfflineNoteAssets(document(), SUBJECT, otherWorkspace, NOTE, client);
      if (failure === 'locked') {
        itemLock = {
          locked: true,
          unlockedUntil: null,
          lockItemId: FILE,
          selfLocked: true,
        };
      } else {
        queryMock.mockRejectedValue(
          new NixApiError({
            kind: 'http',
            code: 'http.403',
            status: 403,
            message: 'The image is no longer readable.',
          }),
        );
      }

      await expect(
        cacheOfflineNoteAssets(document(), SUBJECT, WORKSPACE, NOTE, client),
      ).rejects.toThrow();

      expect(await readOfflineNoteAsset(noteScope(), FILE)).toBeNull();
      expect(await readOfflineNoteAsset(noteScope(NOTE, otherWorkspace), FILE)).toBeNull();
      expect(await storedAssets()).toEqual([]);
    },
  );

  it('keeps the saved image when its authorized version has not changed', async () => {
    const doc = document();
    await cacheOfflineNoteAssets(doc, SUBJECT, WORKSPACE, NOTE, client);
    await cacheOfflineNoteAssets(doc, SUBJECT, WORKSPACE, NOTE, client);

    expect(files.fetchFileContent).toHaveBeenCalledOnce();
    expect(await readOfflineNoteAsset(noteScope(), FILE)).not.toBeNull();
  });

  it('downloads the new bytes when an authorized image version changes', async () => {
    const doc = document();
    await cacheOfflineNoteAssets(doc, SUBJECT, WORKSPACE, NOTE, client);
    const updatedBytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
    const updated = download({ bytes: updatedBytes, sha: 'b'.repeat(64) });
    currentCapability = updated.capability;
    vi.mocked(files.fetchFileContent).mockResolvedValue(updated);
    await cacheOfflineNoteAssets(doc, SUBJECT, WORKSPACE, NOTE, client);

    expect(files.fetchFileContent).toHaveBeenCalledTimes(2);
    const saved = await readOfflineNoteAsset(noteScope(), FILE);
    expect(saved === null ? null : Array.from(new Uint8Array(await saved.arrayBuffer()))).toEqual(
      Array.from(updatedBytes),
    );
    expect(await storedAssets()).toMatchObject([{ sha256: updated.capability.sha256 }]);
  });

  it('finishes deleting its image store before reporting that it is cleared', async () => {
    await cacheOfflineNoteAssets(document(), SUBJECT, WORKSPACE, NOTE, client);

    await clearOfflineNoteAssets();

    expect(await storedAssets()).toEqual([]);
    expect(await readOfflineNoteAsset(noteScope(), FILE)).toBeNull();
  });

  it('reports an image-store clear failure', async () => {
    await cacheOfflineNoteAssets(document(), SUBJECT, WORKSPACE, NOTE, client);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(IDBObjectStore.prototype, 'clear').mockImplementation(() => {
      throw new DOMException('Offline images could not be cleared.', 'UnknownError');
    });

    await expect(clearOfflineNoteAssets()).rejects.toThrow('Offline images could not be cleared.');
    expect(await storedAssets()).toHaveLength(1);
  });

  it('keeps a refused file unreadable after deletion fails and the module reloads', async () => {
    const doc = document();
    await cacheOfflineNoteAssets(doc, SUBJECT, WORKSPACE, NOTE, client);
    vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(() => {
      throw new DOMException('Offline image deletion failed.', 'UnknownError');
    });
    queryMock.mockRejectedValue(
      new NixApiError({
        kind: 'http',
        code: 'http.403',
        status: 403,
        message: 'The image is no longer readable.',
      }),
    );

    await expect(cacheOfflineNoteAssets(doc, SUBJECT, WORKSPACE, NOTE, client)).rejects.toThrow();
    expect(localStorage.getItem(refusalMarker(FILE))).not.toBeNull();
    expect(await storedAssets()).toHaveLength(1);

    vi.resetModules();
    const reloaded = await import('../../offline/offline-assets');

    expect(await reloaded.readOfflineNoteAsset(noteScope(), FILE)).toBeNull();
  });

  it('closes image admission when refusal-marker storage fails and preserves pending drafts', async () => {
    const doc = document();
    const draft = {
      id: 'asset-marker-draft',
      scope: noteScope(),
      revision: 1,
      update: Y.encodeStateAsUpdate(doc),
    };
    await writeDraft(draft);
    await cacheOfflineNoteAssets(doc, SUBJECT, WORKSPACE, NOTE, client);
    const setItem = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key.startsWith(REFUSED_PREFIX))
        throw new DOMException('Refusal-marker storage is full.', 'QuotaExceededError');
      setItem(key, value);
    });
    queryMock.mockRejectedValue(
      new NixApiError({
        kind: 'http',
        code: 'http.403',
        status: 403,
        message: 'The image is no longer readable.',
      }),
    );

    await expect(cacheOfflineNoteAssets(doc, SUBJECT, WORKSPACE, NOTE, client)).rejects.toThrow();

    expect(localStorage.getItem(ASSET_SUBJECT_MARKER)).toBeNull();
    expect(await readOfflineNoteAsset(noteScope(), FILE)).toBeNull();
    expect(bodyCacheAccountAdmits(SUBJECT)).toBe(true);
    expect((await readDrafts(noteScope())).map((record) => record.id)).toEqual([draft.id]);
    await writeDraft({ ...draft, revision: 2 });
    expect((await readDrafts(noteScope())).map((record) => record.revision)).toEqual([2]);
  });

  it('restores an unlocked image only after fresh Core authorization saves it again', async () => {
    const doc = document();
    await cacheOfflineNoteAssets(doc, SUBJECT, WORKSPACE, NOTE, client);
    itemLock = { locked: true, unlockedUntil: null, lockItemId: FILE, selfLocked: true };
    await expect(cacheOfflineNoteAssets(doc, SUBJECT, WORKSPACE, NOTE, client)).rejects.toThrow();
    expect(localStorage.getItem(refusalMarker(FILE))).not.toBeNull();
    expect(await readOfflineNoteAsset(noteScope(), FILE)).toBeNull();
    itemLock = { locked: false, unlockedUntil: null, lockItemId: null, selfLocked: false };
    queryMock.mockClear();
    vi.mocked(files.fetchFileContent).mockClear();

    await cacheOfflineNoteAssets(doc, SUBJECT, WORKSPACE, NOTE, client);

    expect(queryMock).toHaveBeenCalledWith(locks.getItemLock(FILE), {
      signal: undefined,
      forceRefresh: true,
    });
    expect(queryMock).toHaveBeenCalledWith(files.downloadFile(FILE, undefined, true), {
      signal: undefined,
      forceRefresh: true,
    });
    expect(files.fetchFileContent).toHaveBeenCalledOnce();
    expect(localStorage.getItem(refusalMarker(FILE))).toBeNull();
    expect(await readOfflineNoteAsset(noteScope(), FILE)).not.toBeNull();
  });

  it('keeps refusal markers and closes admission when clearing every image fails', async () => {
    const doc = document();
    const otherFile = '00000000-0000-4000-8000-000000000006';
    await cacheOfflineNoteAssets(doc, SUBJECT, WORKSPACE, NOTE, client);
    itemLock = { locked: true, unlockedUntil: null, lockItemId: FILE, selfLocked: true };
    await expect(cacheOfflineNoteAssets(doc, SUBJECT, WORKSPACE, NOTE, client)).rejects.toThrow();
    itemLock = { locked: false, unlockedUntil: null, lockItemId: null, selfLocked: false };
    await cacheOfflineNoteAssets(document([otherFile]), SUBJECT, WORKSPACE, NOTE, client);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(IDBObjectStore.prototype, 'clear').mockImplementation(() => {
      throw new DOMException('Offline images could not be cleared.', 'UnknownError');
    });

    await expect(clearOfflineNoteAssets()).rejects.toThrow('Offline images could not be cleared.');

    expect(localStorage.getItem(ASSET_SUBJECT_MARKER)).toBeNull();
    expect(localStorage.getItem(refusalMarker(FILE))).not.toBeNull();
    expect(await readOfflineNoteAsset(noteScope(), otherFile)).toBeNull();
    expect(await storedAssets()).toHaveLength(1);
  });

  it('preserves the next account image and refusal markers during late prior-account cleanup', async () => {
    const otherSubject = 'offline-assets-bob';
    const refusedFile = '00000000-0000-4000-8000-000000000007';
    const otherScope = documentScope(otherSubject, WORKSPACE, NOTE, 'note');
    if (otherScope === undefined) throw new Error('Missing second-account note scope.');
    await openBodyCache(otherSubject);
    await cacheOfflineNoteAssets(document(), otherSubject, WORKSPACE, NOTE, client);
    const otherRefusal = `${REFUSED_PREFIX}${JSON.stringify([otherSubject, refusedFile])}`;
    localStorage.setItem(otherRefusal, 'refused');
    localStorage.setItem(refusalMarker(refusedFile), 'refused');
    await seedAsset(noteScope(), FILE);

    await clearOfflineNoteAssets(SUBJECT);

    expect(localStorage.getItem(ASSET_SUBJECT_MARKER)).toBe(otherSubject);
    expect(localStorage.getItem(otherRefusal)).toBe('refused');
    expect(localStorage.getItem(refusalMarker(refusedFile))).toBeNull();
    expect(await readOfflineNoteAsset(otherScope, FILE)).not.toBeNull();
    expect(await readOfflineNoteAsset(otherScope, refusedFile)).toBeNull();
    expect(await storedAssets()).toMatchObject([{ scope: otherScope, fileItemId: FILE }]);
  });

  it('skips delayed image cleanup after the same account opens a fresh cache lifecycle', async () => {
    const doc = document();
    await cacheOfflineNoteAssets(doc, SUBJECT, WORKSPACE, NOTE, client);
    const previousEpoch = bodyCacheAccountEpoch(SUBJECT);
    vi.resetModules();
    const reloaded = await import('../../offline/offline-assets');
    const actualOpen = indexedDB.open.bind(indexedDB);
    let openingSpy: MockInstance<IDBFactory['open']> | undefined;
    const openingHeld = new Promise<() => void>((resolve) => {
      openingSpy = vi.spyOn(indexedDB, 'open').mockImplementation((name, version) => {
        const request = actualOpen(name, version);
        if (name === 'nix-offline-note-assets') {
          request.addEventListener(
            'success',
            (event) => {
              event.stopImmediatePropagation();
              resolve(() => {
                request.onsuccess?.call(request, event);
              });
            },
            { once: true },
          );
        }
        return request;
      });
    });
    const clearing = reloaded.clearOfflineNoteAssets(SUBJECT);
    const releaseOpening = await openingHeld;
    openingSpy?.mockRestore();
    await clearBodyCache(SUBJECT);
    await openBodyCache(SUBJECT);
    expect(bodyCacheAccountEpoch(SUBJECT)).not.toBe(previousEpoch);
    const freshBytes = new Uint8Array([137, 80, 78, 71, 5, 6, 7, 8]);
    const fresh = download({ bytes: freshBytes, sha: 'c'.repeat(64) });
    currentCapability = fresh.capability;
    vi.mocked(files.fetchFileContent).mockResolvedValue(fresh);
    await cacheOfflineNoteAssets(doc, SUBJECT, WORKSPACE, NOTE, client);
    const refusal = refusalMarker('00000000-0000-4000-8000-000000000008');
    localStorage.setItem(refusal, 'refused');

    releaseOpening();
    await clearing;

    expect(localStorage.getItem(ASSET_SUBJECT_MARKER)).toBe(SUBJECT);
    expect(localStorage.getItem(refusal)).toBe('refused');
    const saved = await readOfflineNoteAsset(noteScope(), FILE);
    expect(saved === null ? null : Array.from(new Uint8Array(await saved.arrayBuffer()))).toEqual(
      Array.from(freshBytes),
    );
    expect(await storedAssets()).toMatchObject([
      { scope: noteScope(), sha256: fresh.capability.sha256 },
    ]);
  });
  it('ignores a sign-out epoch captured before the same account signs in again', async () => {
    const previousEpoch = bodyCacheAccountEpoch(SUBJECT);
    await clearBodyCache(SUBJECT);
    await openBodyCache(SUBJECT);
    expect(bodyCacheAccountEpoch(SUBJECT)).not.toBe(previousEpoch);
    await cacheOfflineNoteAssets(document(), SUBJECT, WORKSPACE, NOTE, client);
    const refusal = refusalMarker('00000000-0000-4000-8000-000000000008');
    localStorage.setItem(refusal, 'refused');

    await clearOfflineNoteAssets(SUBJECT, previousEpoch);

    expect(localStorage.getItem(ASSET_SUBJECT_MARKER)).toBe(SUBJECT);
    expect(localStorage.getItem(refusal)).toBe('refused');
    expect(await readOfflineNoteAsset(noteScope(), FILE)).not.toBeNull();
    expect(await storedAssets()).toMatchObject([{ scope: noteScope(), fileItemId: FILE }]);
  });
});
