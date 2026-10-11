import 'fake-indexeddb/auto';
import { IDBObjectStore } from 'fake-indexeddb';
import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type Workspace } from '@nix/api-client';

import {
  bodyCacheAccountEpoch,
  clearBodyCache,
  documentScope,
  openBodyCache,
  readBodyCache,
} from '../../editor/body-cache';
import * as store from '../../offline/offline-store';

const profile = { subject: 'subject-ada', name: 'Ada', email: 'ada@example.test' };
const workspace: Workspace = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Notes',
  versionRetentionDays: 30,
  storageQuotaBytes: '100000000',
  createdAt: '2026-01-01T00:00:00Z',
  kind: 'personal',
  canRename: true,
  canManageMembers: true,
  canLeave: false,
  canUseDailyNotes: true,
  pendingInvitationId: null,
  lifecycleState: 'active',
  archivedAt: null,
};

function published(id: string): store.OfflineNote {
  return {
    id,
    workspaceId: workspace.id,
    parentId: null,
    title: `Note ${id}`,
    canWrite: true,
    bodyAvailable: true,
    publication: { kind: 'published', serverId: id, docId: `doc:${id}` },
    pendingTitle: null,
    blockedReason: null,
  };
}

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
  await store.clearOfflineData();
  await clearBodyCache();
  await openBodyCache(profile.subject);
  await store.rememberOfflineAccount(profile);
  await store.saveOfflineWorkspaces([workspace]);
});

describe('offline note metadata', () => {
  it('persists a complete new note and recovers it in a fresh module after reload', async () => {
    const created = await store.createOfflineNote(workspace.id, null, '  Offline thought  ');
    const scope = documentScope(profile.subject, workspace.id, created.id, 'note');
    if (scope === undefined) throw new Error('Missing scope');
    expect((await readBodyCache(scope))?.docId).toBe(`local:${created.id}`);

    await store.renameOfflineNote(created.id, 'A better title');
    vi.resetModules();
    const reloaded = await import('../../offline/offline-store');
    await reloaded.loadOfflineNotes();
    expect(reloaded.getOfflineSnapshot().account).toEqual(profile);
    expect(reloaded.getOfflineSnapshot().workspaces).toEqual([workspace]);
    expect(reloaded.getOfflineSnapshot().notes).toEqual([
      {
        ...created,
        title: 'A better title',
        pendingTitle: 'A better title',
      },
    ]);
  });

  it('keeps an immutable creation request while concurrent rename and publication writes commit', async () => {
    const created = await store.createOfflineNote(workspace.id, null, 'Original title');
    await Promise.all([
      store.renameOfflineNote(created.id, 'Changed offline'),
      store.updateOfflineNote(created.id, (note) => {
        if (note.publication.kind !== 'pending') throw new Error('Expected pending create');
        return {
          ...note,
          publication: {
            ...note.publication,
            kind: 'publishing',
            serverId: 'server-1',
            docId: null,
          },
        };
      }),
    ]);
    const persisted = await store.getPersistedOfflineNote(created.id);
    expect(persisted).toMatchObject({
      id: created.id,
      title: 'Changed offline',
      pendingTitle: 'Changed offline',
      publication: {
        kind: 'publishing',
        serverId: 'server-1',
        docId: null,
        originalTitle: 'Original title',
        originalParentId: null,
      },
    });
    expect(store.getOfflineSnapshot().notes).toEqual([persisted]);
  });

  it('keeps more than two hundred notes through a disk reload', async () => {
    for (let index = 0; index < 205; index += 1)
      await store.saveOfflineNote(published(`note-${String(index)}`));
    await store.loadOfflineNotes();
    expect(store.getOfflineSnapshot().notes).toHaveLength(205);
    expect(await store.getPersistedOfflineNote('note-0')).toEqual(published('note-0'));
  });

  it('checks parent availability and preserves the original local parent for publication', async () => {
    const parent = await store.createOfflineNote(workspace.id, null, 'Parent');
    const child = await store.createOfflineNote(workspace.id, parent.id, 'Child');
    expect(child.parentId).toBe(parent.id);
    expect(child.publication).toMatchObject({ originalParentId: parent.id });
    await store.updateOfflineNote(parent.id, (note) => ({ ...note, canWrite: false }));
    await expect(store.createOfflineNote(workspace.id, parent.id, 'Refused')).rejects.toThrow(
      'Choose an available note',
    );
    await expect(store.renameOfflineNote(parent.id, 'Refused')).rejects.toThrow(
      'cannot be changed',
    );
    expect(store.getOfflineSnapshot().notes).toHaveLength(2);
  });

  it('rejects invalid title and identity changes without damaging the existing note', async () => {
    const note = published('note-1');
    await store.saveOfflineNote(note);
    await expect(store.renameOfflineNote(note.id, ' ')).rejects.toThrow('between 1 and 255');
    await expect(
      store.updateOfflineNote(note.id, (current) => ({ ...current, id: 'different' })),
    ).rejects.toThrow('cannot change its identity');
    expect(await store.getPersistedOfflineNote(note.id)).toEqual(note);
    await store.renameOfflineNote(note.id, 'Valid after an aborted write');
    expect((await store.getPersistedOfflineNote(note.id))?.title).toBe(
      'Valid after an aborted write',
    );
  });

  it('does not retain profile fields outside the validated identity', async () => {
    const extra = { ...profile, roles: ['owner'], token: 'never-persist' };
    await store.rememberOfflineAccount(extra);
    expect(JSON.parse(localStorage.getItem('nix.offline.account') ?? 'null')).toEqual(profile);
  });

  it('drops account data before admitting a different account', async () => {
    await store.saveOfflineNote(published('private'));
    await store.rememberOfflineAccount({ subject: 'subject-bo', name: 'Bo', email: null });
    expect(store.getOfflineSnapshot().notes).toEqual([]);
    expect(store.getOfflineSnapshot().workspaces).toEqual([]);
    await store.rememberOfflineAccount(profile);
    expect(store.getOfflineSnapshot().notes).toEqual([]);
  });

  it.each([false, true])(
    'keeps a newer account intact while old cleanup waits for IndexedDB, returning to the original account: %s',
    async (returnsToOriginal) => {
      await store.saveOfflineNote(published('ada-private'));
      vi.resetModules();
      const departingTab = await import('../../offline/offline-store');
      const realOpen = indexedDB.open.bind(indexedDB);
      let releaseOpen: (() => void) | undefined;
      const opening = vi.spyOn(indexedDB, 'open').mockImplementationOnce((...args) => {
        const request = realOpen(...args);
        request.addEventListener(
          'success',
          (event) => {
            const handler = request.onsuccess;
            if (handler === null)
              throw new Error('The storage success callback was not registered.');
            releaseOpen = () => {
              handler.call(request, event);
            };
            event.stopImmediatePropagation();
          },
          { once: true },
        );
        return request;
      });
      const cleanup = departingTab.clearOfflineData(profile.subject);
      await waitFor(() => {
        expect(releaseOpen).toBeDefined();
      });
      opening.mockRestore();

      const bo = { subject: 'subject-bo', name: 'Bo', email: null };
      await openBodyCache(bo.subject);
      await store.rememberOfflineAccount(bo);
      await store.saveOfflineWorkspaces([workspace], bo.subject);
      await store.saveOfflineNote(published('bo-new-note'), bo.subject);
      const current = returnsToOriginal ? profile : bo;
      const expectedNote = published(returnsToOriginal ? 'ada-new-note' : 'bo-new-note');
      if (returnsToOriginal) {
        await openBodyCache(profile.subject);
        await store.rememberOfflineAccount(profile);
        await store.saveOfflineWorkspaces([workspace], profile.subject);
        await store.saveOfflineNote(expectedNote, profile.subject);
      }
      if (releaseOpen === undefined) throw new Error('The storage callback was not captured.');
      releaseOpen();
      await cleanup;

      expect(store.readOfflineAccount()).toEqual(current);
      expect(store.getOfflineSnapshot().account).toEqual(current);
      expect(store.getOfflineSnapshot().notes).toContainEqual(expectedNote);
      expect(await store.getPersistedOfflineNote(expectedNote.id, current.subject)).toEqual(
        expectedNote,
      );
      await store.loadOfflineNotes();
      expect(store.getOfflineSnapshot().workspaces).toEqual([workspace]);
      if (!returnsToOriginal) {
        await store.rememberOfflineAccount(profile);
        expect(store.getOfflineSnapshot().notes).toEqual([]);
      }
    },
  );

  it('does not forget the current account when cleanup names a different owner', async () => {
    await store.saveOfflineNote(published('kept'));
    store.forgetOfflineAccount('subject-bo');
    await store.clearOfflineData('subject-bo');
    expect(store.readOfflineAccount()).toEqual(profile);
    expect(store.getOfflineSnapshot().notes).toEqual([published('kept')]);
    expect(await store.getPersistedOfflineNote('kept')).toEqual(published('kept'));
    await store.loadOfflineNotes();
    expect(store.getOfflineSnapshot().workspaces).toEqual([workspace]);
  });

  it('ignores a delayed signout broadcast for an earlier account', async () => {
    await store.saveOfflineNote(published('kept'));
    const listener = vi.fn();
    const unsubscribe = store.subscribeOfflineNotes(listener);
    const otherTab = new BroadcastChannel('nix-offline-notes');
    try {
      otherTab.postMessage({ kind: 'forgotten', subject: 'subject-bo', epoch: null });
      await waitFor(() => {
        expect(listener).toHaveBeenCalled();
      });
      expect(store.readOfflineAccount()).toEqual(profile);
      expect(store.getOfflineSnapshot().notes).toEqual([published('kept')]);
    } finally {
      otherTab.close();
      unsubscribe();
    }
  });

  it('protects a fresh admission for the same account from a delayed signout broadcast', async () => {
    const departedEpoch = bodyCacheAccountEpoch(profile.subject);
    await clearBodyCache(profile.subject);
    await openBodyCache(profile.subject);
    expect(bodyCacheAccountEpoch(profile.subject)).not.toBe(departedEpoch);
    await store.saveOfflineNote(published('fresh-admission'));
    const listener = vi.fn();
    const unsubscribe = store.subscribeOfflineNotes(listener);
    const otherTab = new BroadcastChannel('nix-offline-notes');
    try {
      otherTab.postMessage({ kind: 'forgotten', subject: profile.subject, epoch: departedEpoch });
      otherTab.postMessage('changed');
      await waitFor(() => {
        expect(listener).toHaveBeenCalled();
      });
      expect(store.readOfflineAccount()).toEqual(profile);
      expect(store.getOfflineSnapshot().notes).toEqual([published('fresh-admission')]);
      store.forgetOfflineAccount(profile.subject, departedEpoch);
      expect(store.readOfflineAccount()).toEqual(profile);
    } finally {
      otherTab.close();
      unsubscribe();
    }
  });

  it('rejects an earlier same-account mutation while its database open waits for a new admission', async () => {
    await store.saveOfflineNote(published('shared-note'));
    vi.resetModules();
    const oldTab = await import('../../offline/offline-store');
    const realOpen = indexedDB.open.bind(indexedDB);
    let releaseOpen: (() => void) | undefined;
    const opening = vi.spyOn(indexedDB, 'open').mockImplementationOnce((...args) => {
      const request = realOpen(...args);
      request.addEventListener(
        'success',
        (event) => {
          const handler = request.onsuccess;
          if (handler === null) throw new Error('The storage success callback was not registered.');
          releaseOpen = () => {
            handler.call(request, event);
          };
          event.stopImmediatePropagation();
        },
        { once: true },
      );
      return request;
    });
    const changed = vi.fn((note: store.OfflineNote) => ({
      ...note,
      title: 'Old tab must not overwrite this',
    }));
    const mutation = oldTab
      .updateOfflineNote('shared-note', changed, profile.subject)
      .catch((cause: unknown) => cause);
    await waitFor(() => {
      expect(releaseOpen).toBeDefined();
    });
    opening.mockRestore();

    await openBodyCache('subject-bo');
    await openBodyCache(profile.subject);
    const fresh = { ...published('shared-note'), title: 'Saved by the new admission' };
    await store.saveOfflineNote(fresh, profile.subject);
    if (releaseOpen === undefined) throw new Error('The storage callback was not captured.');
    releaseOpen();
    expect(await mutation).toBeInstanceOf(Error);
    expect(changed).not.toHaveBeenCalled();
    expect(await store.getPersistedOfflineNote(fresh.id)).toEqual(fresh);
    expect(store.getOfflineSnapshot().notes).toEqual([fresh]);
  });

  it('aborts an atomic write if its admission changes inside the write callback', async () => {
    const original = published('changed-admission');
    await store.saveOfflineNote(original);
    await expect(
      store.updateOfflineNote(original.id, (note) => {
        localStorage.setItem(
          `nix.body-cache.epoch.${JSON.stringify(profile.subject)}`,
          crypto.randomUUID(),
        );
        return { ...note, title: 'Refused write' };
      }),
    ).rejects.toThrow('account changed');
    expect(await store.getPersistedOfflineNote(original.id)).toEqual(original);
    expect(store.getOfflineSnapshot().notes).toEqual([original]);
  });

  it('refuses a queued write even when the same account signs in again after forgetting', async () => {
    const queued = store.saveOfflineNote(published('late'));
    const result = queued.catch((cause: unknown) => cause);
    store.forgetOfflineAccount();
    await store.rememberOfflineAccount(profile);
    expect(await result).toBeInstanceOf(Error);
    expect(await store.getPersistedOfflineNote('late')).toBeNull();
    expect(store.getOfflineSnapshot().notes).toEqual([]);
  });

  it('keeps saved state honest when IndexedDB refuses a write, and permits retry', async () => {
    const write = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => {
      throw new DOMException('Device storage is full.', 'QuotaExceededError');
    });
    await expect(store.saveOfflineNote(published('full'))).rejects.toThrow(
      'Device storage is full',
    );
    write.mockRestore();
    expect(store.getOfflineSnapshot().notes).toEqual([]);
    expect(await store.getPersistedOfflineNote('full')).toBeNull();
    await store.saveOfflineNote(published('full'));
    expect(await store.getPersistedOfflineNote('full')).toEqual(published('full'));
  });

  it('does not announce an available new note when its initial body was refused', async () => {
    await clearBodyCache();
    await expect(store.createOfflineNote(workspace.id, null, 'No body')).rejects.toThrow(
      /could not be saved|closed|account/i,
    );
    expect(store.getOfflineSnapshot().notes).toEqual([]);
  });

  it('synchronously disables a forgotten server body and persists the refusal', async () => {
    const note = published('server-note');
    await store.saveOfflineNote(note);
    const pending = await store.createOfflineNote(workspace.id, null, 'Pending survives');
    const scope = documentScope(profile.subject, workspace.id, note.id, 'note');
    if (scope === undefined) throw new Error('Missing scope');
    store.markOfflineBodyUnavailable(scope);
    expect(
      store.getOfflineSnapshot().notes.find((candidate) => candidate.id === note.id),
    ).toMatchObject({ bodyAvailable: false, canWrite: false });
    expect(
      store.getOfflineSnapshot().notes.find((candidate) => candidate.id === pending.id)
        ?.bodyAvailable,
    ).toBe(true);
    await waitFor(async () => {
      const persisted = await store.getPersistedOfflineNote(note.id);
      expect(persisted).toMatchObject({
        bodyAvailable: false,
        canWrite: false,
      });
      expect(persisted?.blockedReason).toContain('Reconnect');
    });
  });

  it('binds reads and mutations to the account that started the operation', async () => {
    await store.saveOfflineNote(published('private'));
    await store.rememberOfflineAccount({ subject: 'subject-bo', name: 'Bo', email: null });
    await expect(store.saveOfflineNote(published('foreign'), profile.subject)).rejects.toThrow(
      'account changed',
    );
    await expect(store.saveOfflineWorkspaces([workspace], profile.subject)).rejects.toThrow(
      'account changed',
    );
    await expect(store.getPersistedOfflineNote('private', profile.subject)).rejects.toThrow(
      'account changed',
    );
    await expect(store.removeOfflineNote('private', profile.subject)).rejects.toThrow(
      'account changed',
    );
    await expect(
      store.updateOfflineNote('private', (note) => note, profile.subject),
    ).rejects.toThrow('account changed');
    expect(store.getOfflineSnapshot().notes).toEqual([]);
  });

  it('retries opening IndexedDB after an immediate storage failure', async () => {
    vi.resetModules();
    const reloaded = await import('../../offline/offline-store');
    const opening = vi.spyOn(indexedDB, 'open').mockImplementationOnce(() => {
      throw new DOMException('Storage is temporarily unavailable.', 'SecurityError');
    });
    await expect(reloaded.loadOfflineNotes()).rejects.toThrow('temporarily unavailable');
    opening.mockRestore();
    await reloaded.loadOfflineNotes();
    expect(reloaded.getOfflineSnapshot().account).toEqual(profile);
    expect(reloaded.getOfflineSnapshot().workspaces).toEqual([workspace]);
  });

  it('refreshes durable metadata written by another tab', async () => {
    const unsubscribe = store.subscribeOfflineNotes(vi.fn());
    try {
      vi.resetModules();
      const otherTab = await import('../../offline/offline-store');
      await otherTab.saveOfflineNote(published('other-tab'));
      await waitFor(() => {
        expect(store.getOfflineSnapshot().notes).toEqual([published('other-tab')]);
      });
    } finally {
      unsubscribe();
    }
  });

  it('refreshes subscriptions when another tab changes the account marker', async () => {
    await store.saveOfflineNote(published('private'));
    const listener = vi.fn();
    const unsubscribe = store.subscribeOfflineNotes(listener);
    localStorage.removeItem('nix.offline.account');
    window.dispatchEvent(new StorageEvent('storage', { key: 'nix.offline.account' }));
    expect(store.getOfflineSnapshot().account).toBeNull();
    expect(store.getOfflineSnapshot().notes).toEqual([]);
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });
});
