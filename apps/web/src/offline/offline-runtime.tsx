import {
  isNixApiError,
  items,
  locks,
  workspaces,
  type Item,
  type ItemLock,
  type NixClient,
} from '@nix/api-client';
import { useEffect } from 'react';
import * as Y from 'yjs';

import { useApiClient } from '../api/api-client-provider';
import { useAuth } from '../auth/auth-provider';
import { useSessionStore } from '../auth/session-store';
import {
  bodyCacheAccountEpoch,
  discardBodyCache,
  documentScope,
  onBodyForgetting,
  readBodyCache,
  reopenRefusedItemBodies,
  sealItemBodies,
} from '../editor/body-cache';
import { flushLocalDraftsForAccount, flushLocalDraftsForScope } from '../editor/collab-sync';
import { listDraftScopes, migrateLocalDrafts } from '../editor/draft-journal';
import { cacheOfflineNoteAssets } from './offline-assets';
import { synchronizeOfflineBody } from './offline-body';
import { useOfflinePreference } from './offline-preference';
import {
  getOfflineSnapshot,
  getPersistedOfflineNote,
  loadOfflineNotes,
  markOfflineBodyUnavailable,
  readOfflineAccount,
  removeOfflineNote,
  saveOfflineNote,
  saveOfflineWorkspaces,
  setOfflineProgress,
  updateOfflineNote,
  type OfflineNote,
} from './offline-store';

const SYNC_EVENT = 'nix:offline-sync-requested';
const PUBLISHING = 'Publishing this note. Editing resumes when the local copy has moved.';

export function requestOfflineSync(): void {
  window.dispatchEvent(new Event(SYNC_EVENT));
}

interface SyncOptions {
  readonly client: NixClient;
  readonly subject: string;
  readonly getAccessToken: () => Promise<string | null>;
  readonly signal: AbortSignal;
}
interface BoundSyncOptions extends SyncOptions {
  readonly accountEpoch: string;
}

function assertAccount(options: BoundSyncOptions): void {
  options.signal.throwIfAborted();
  assertSameAccount(options);
}
function assertSameAccount({ subject, accountEpoch }: BoundSyncOptions): void {
  if (readOfflineAccount()?.subject !== subject || bodyCacheAccountEpoch(subject) !== accountEpoch)
    throw new Error('The offline account changed.');
}
function updateNote(
  id: string,
  change: (note: OfflineNote) => OfflineNote,
  options: BoundSyncOptions,
): Promise<OfflineNote> {
  assertSameAccount(options);
  return updateOfflineNote(
    id,
    (current) => {
      assertSameAccount(options);
      return change(current);
    },
    options.subject,
  );
}
function scopeFor(subject: string, note: OfflineNote, itemId = note.id): string {
  const scope = documentScope(subject, note.workspaceId, itemId, 'note');
  if (scope === undefined) throw new Error('This note has no local storage scope.');
  return scope;
}
function serverId(note: OfflineNote): string {
  return note.publication.kind === 'pending' ? note.id : note.publication.serverId;
}
function sessionRefused(error: unknown): boolean {
  return isNixApiError(error) && (error.status === 401 || error.code === 'auth.principal_inactive');
}
function refused(error: unknown): boolean {
  return (
    isNixApiError(error) &&
    ([403, 404, 410, 423].includes(error.status ?? 0) || refusalReason(error) === 'locked')
  );
}
function refusalReason(error: unknown): 'locked' | 'refused' {
  return isNixApiError(error) &&
    (error.status === 423 ||
      ['body_locked', 'internal.body_locked', 'items.locked'].includes(error.code))
    ? 'locked'
    : 'refused';
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Offline notes could not be synchronized.';
}

async function publishNote(note: OfflineNote, options: BoundSyncOptions): Promise<OfflineNote> {
  const { client, subject, signal } = options;
  if (note.publication.kind === 'published') return note;
  assertAccount(options);
  const localScope = scopeFor(subject, note);
  try {
    await updateNote(note.id, (current) => ({ ...current, blockedReason: PUBLISHING }), options);
    // Snapshot subscribers disable the active editor before its final local flush.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    await flushLocalDraftsForScope(localScope);
    assertAccount(options);
    let current = await getPersistedOfflineNote(note.id, subject);
    if (current === null) throw new Error('The local note was removed before publication.');
    if (current.publication.kind === 'pending') {
      const publication = current.publication;
      const parent =
        publication.originalParentId === null
          ? null
          : await getPersistedOfflineNote(publication.originalParentId, subject);
      if (parent !== null && parent.publication.kind !== 'published')
        throw new Error('The parent note must finish synchronizing first.');
      const created = await client.execute(
        items.createItem(current.workspaceId, {
          type: 'note',
          title: publication.originalTitle,
          parentId: parent === null ? publication.originalParentId : serverId(parent),
          idempotencyKey: publication.key,
        }),
        { signal },
      );
      assertSameAccount(options);
      current = await updateNote(
        current.id,
        (latest) => ({
          ...latest,
          publication: { ...publication, kind: 'publishing', serverId: created.id, docId: null },
        }),
        options,
      );
    }
    if (current.publication.kind === 'publishing') {
      await migrateLocalDrafts(
        localScope,
        scopeFor(subject, current, current.publication.serverId),
        { createdItemId: current.publication.serverId },
      );
      assertSameAccount(options);
      current = await updateNote(
        current.id,
        (latest) => {
          if (latest.publication.kind !== 'publishing') return latest;
          return {
            ...latest,
            blockedReason: null,
            publication: {
              kind: 'published',
              serverId: latest.publication.serverId,
              docId: `local:${latest.publication.serverId}`,
            },
          };
        },
        options,
      );
    }
    if (current.publication.kind === 'published') {
      const publishedId = current.publication.serverId;
      for (const duplicate of getOfflineSnapshot().notes) {
        if (
          duplicate.id === current.id ||
          duplicate.publication.kind !== 'published' ||
          duplicate.publication.serverId !== publishedId
        )
          continue;
        if (
          duplicate.pendingTitle !== null &&
          current.pendingTitle !== null &&
          duplicate.pendingTitle !== current.pendingTitle
        ) {
          await updateNote(
            duplicate.id,
            (latest) => ({
              ...latest,
              bodyAvailable: false,
              canWrite: false,
              blockedReason:
                'Two local title changes conflict. Export this saved title for recovery.',
            }),
            options,
          );
        } else {
          if (duplicate.pendingTitle !== null)
            current = await updateNote(
              current.id,
              (latest) => ({
                ...latest,
                title: latest.pendingTitle ?? duplicate.pendingTitle ?? latest.title,
                pendingTitle: latest.pendingTitle ?? duplicate.pendingTitle,
              }),
              options,
            );
          await removeOfflineNote(duplicate.id, subject);
        }
      }
    }
    return current;
  } catch (error) {
    if (sessionRefused(error)) throw error;
    if (readOfflineAccount()?.subject === subject) {
      await updateNote(
        note.id,
        (latest) => ({
          ...latest,
          blockedReason:
            latest.publication.kind === 'publishing'
              ? PUBLISHING
              : refused(error)
                ? 'Nix refused this note. Its local work is preserved; restore access and retry synchronization.'
                : null,
        }),
        options,
      );
    }
    throw error;
  }
}

async function synchronizeBody(
  note: OfflineNote,
  options: BoundSyncOptions,
): Promise<{ docId: string; canWrite: boolean; assetError: string | null }> {
  const { subject, signal } = options;
  const id = serverId(note);
  const scope = scopeFor(subject, note, id);
  const doc = new Y.Doc();
  let readOnlyUpdate: Promise<void> | undefined;
  const timeout = new AbortController();
  const timer = setTimeout(() => {
    timeout.abort(new Error('This note did not finish downloading. Retry when Nix is reachable.'));
  }, 30_000);
  try {
    const body = await synchronizeOfflineBody({
      client: options.client,
      subject,
      workspaceId: note.workspaceId,
      itemId: id,
      doc,
      signal: AbortSignal.any([signal, timeout.signal]),
      onReadOnly: () => {
        readOnlyUpdate ??= (async () => {
          const current = await getPersistedOfflineNote(note.id, subject);
          if (current !== null)
            await updateNote(note.id, (latest) => ({ ...latest, canWrite: false }), options);
        })().catch((error: unknown) => {
          if (
            readOfflineAccount()?.subject === subject &&
            bodyCacheAccountEpoch(subject) === options.accountEpoch
          )
            markOfflineBodyUnavailable(scope);
          throw error;
        });
        return readOnlyUpdate;
      },
    });
    await readOnlyUpdate;
    assertAccount(options);
    const cached = await readBodyCache(scope);
    if (cached === null) throw new Error('This note could not be saved on this device.');
    let assetError: string | null = null;
    try {
      await cacheOfflineNoteAssets(doc, subject, note.workspaceId, id, options.client, signal);
    } catch (error) {
      assertAccount(options);
      assetError = errorMessage(error);
    }
    assertAccount(options);
    return { docId: cached.docId, canWrite: body.canWrite, assetError };
  } catch (error) {
    await readOnlyUpdate;
    throw error;
  } finally {
    clearTimeout(timer);
    doc.destroy();
  }
}

async function publishPendingNotes(options: BoundSyncOptions): Promise<string[]> {
  const failures: string[] = [];
  const remaining = new Map(
    getOfflineSnapshot()
      .notes.filter((note) => note.publication.kind !== 'published')
      .map((note) => [note.id, note]),
  );
  while (remaining.size > 0) {
    let progressed = false;
    for (const note of remaining.values()) {
      assertAccount(options);
      if (note.parentId !== null && remaining.has(note.parentId)) continue;
      const parent =
        note.parentId === null
          ? null
          : await getPersistedOfflineNote(note.parentId, options.subject);
      if (parent !== null && parent.publication.kind !== 'published') {
        failures.push(`${note.title}: The parent note is still waiting to synchronize.`);
        remaining.delete(note.id);
        progressed = true;
        continue;
      }
      try {
        await publishNote(note, options);
      } catch (error) {
        assertAccount(options);
        if (
          sessionRefused(error) ||
          !isNixApiError(error) ||
          error.status === undefined ||
          error.status < 400 ||
          error.status >= 500 ||
          [401, 429].includes(error.status)
        )
          throw error;
        failures.push(`${note.title}: ${errorMessage(error)}`);
      }
      remaining.delete(note.id);
      progressed = true;
    }
    if (!progressed) {
      failures.push('Local notes contain a parent cycle and could not be published.');
      break;
    }
  }
  return failures;
}

async function applyPendingTitle(note: OfflineNote, options: BoundSyncOptions): Promise<void> {
  const pendingTitle = note.pendingTitle;
  if (pendingTitle === null || note.publication.kind !== 'published') return;
  await options.client.execute(
    items.renameItem(note.workspaceId, note.publication.serverId, pendingTitle),
    { signal: options.signal },
  );
  assertAccount(options);
  await updateNote(
    note.id,
    (current) =>
      current.pendingTitle === pendingTitle ? { ...current, pendingTitle: null } : current,
    options,
  );
}

async function awaitOfflineShell(signal: AbortSignal): Promise<void> {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator))
    throw new Error('This browser cannot install the offline app.');
  const timeout = AbortSignal.timeout(30_000);
  const waiting = AbortSignal.any([signal, timeout]);
  waiting.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const aborted = (): void => {
      reject(
        new Error(
          'The offline app has not finished installing. Retry when the connection is available.',
        ),
      );
    };
    waiting.addEventListener('abort', aborted, { once: true });
    void navigator.serviceWorker.ready.then(
      () => {
        waiting.removeEventListener('abort', aborted);
        resolve();
      },
      (error: unknown) => {
        waiting.removeEventListener('abort', aborted);
        reject(error instanceof Error ? error : new Error(errorMessage(error)));
      },
    );
  });
}

/** Core queries establish the download set; only a complete traversal can remove an old copy. */
export async function synchronizeOfflineNotes(initialOptions: SyncOptions): Promise<void> {
  const accountEpoch = bodyCacheAccountEpoch(initialOptions.subject);
  if (accountEpoch === null) throw new Error('The offline account changed.');
  const options: BoundSyncOptions = { ...initialOptions, accountEpoch };
  const { client, subject, signal } = options;
  assertAccount(options);
  await loadOfflineNotes();
  assertAccount(options);
  setOfflineProgress({ status: 'syncing', error: null });
  const failures = await publishPendingNotes(options);
  const accessibleWorkspaces = [];
  for await (const workspace of client.paginate(workspaces.listWorkspaces(), {
    signal,
    forceRefresh: true,
  })) {
    if (workspace.lifecycleState === 'active') accessibleWorkspaces.push(workspace);
  }
  assertAccount(options);
  await saveOfflineWorkspaces(accessibleWorkspaces, subject);
  const downloaded = new Set<string>();
  const candidates: Item[] = [];
  const parentById = new Map<string, string | null>();
  const visited = new Set<string>();
  const checkedLocks = new Map<string, ItemLock>();
  const readLock = async (id: string, refresh = false): Promise<ItemLock> => {
    const previous = checkedLocks.get(id);
    if (previous !== undefined && !refresh) return previous;
    const lock = await client.query(locks.getItemLock(id), { signal, forceRefresh: true });
    checkedLocks.set(id, lock);
    return lock;
  };
  const sealLockedCopies = async (workspaceId: string): Promise<void> => {
    const notes = getOfflineSnapshot().notes.filter(
      (note) =>
        note.workspaceId === workspaceId &&
        note.publication.kind === 'published' &&
        note.bodyAvailable,
    );
    for (let index = 0; index < notes.length; index += 1) {
      const note = notes[index];
      if (note === undefined) continue;
      try {
        const lock = await readLock(serverId(note), true);
        assertAccount(options);
        if (lock.locked) await sealItemBodies(subject, workspaceId, serverId(note));
      } catch (error) {
        assertSameAccount(options);
        if (sessionRefused(error)) throw error;
        if (refused(error)) {
          await sealItemBodies(subject, workspaceId, serverId(note), refusalReason(error));
          continue;
        }
        for (const unchecked of notes.slice(index)) {
          const scope = scopeFor(subject, unchecked, serverId(unchecked));
          markOfflineBodyUnavailable(scope);
          await discardBodyCache(scope);
        }
        throw error;
      }
    }
  };
  for (const workspace of accessibleWorkspaces) {
    const parents: (string | undefined)[] = [undefined];
    while (parents.length > 0) {
      const parentId = parents.shift();
      for await (const item of client.paginate(
        items.listItems(workspace.id, { parentId, pageSize: 200 }),
        { signal, forceRefresh: true },
      )) {
        assertAccount(options);
        if (visited.has(item.id)) continue;
        visited.add(item.id);
        let lock: ItemLock;
        try {
          lock = await readLock(item.id);
        } catch (error) {
          assertAccount(options);
          if (sessionRefused(error)) throw error;
          if (!refused(error)) throw error;
          await sealItemBodies(subject, item.workspaceId, item.id, refusalReason(error));
          await sealLockedCopies(item.workspaceId);
          failures.push(`${item.title || 'Untitled note'}: ${errorMessage(error)}`);
          continue;
        }
        if (lock.locked) {
          await sealItemBodies(subject, item.workspaceId, item.id);
          await sealLockedCopies(item.workspaceId);
          continue;
        }
        parentById.set(item.id, item.parentId);
        if (item.hasChildren) parents.push(item.id);
        if (!['canvas', 'spreadsheet', 'file'].includes(item.type)) candidates.push(item);
      }
    }
  }
  setOfflineProgress({ status: 'downloading', completed: 0, total: candidates.length });
  const existingByServerId = new Map<string, OfflineNote>();
  for (const note of getOfflineSnapshot().notes) {
    if (note.publication.kind === 'pending') continue;
    const previous = existingByServerId.get(serverId(note));
    if (previous === undefined || (previous.blockedReason !== null && note.blockedReason === null))
      existingByServerId.set(serverId(note), note);
  }
  await flushLocalDraftsForAccount(subject);
  const pendingScopes = new Set(await listDraftScopes(subject));
  assertAccount(options);
  for (const note of getOfflineSnapshot().notes) {
    if (note.publication.kind !== 'pending' && note.pendingTitle !== null)
      pendingScopes.add(scopeFor(subject, note, serverId(note)));
  }
  const prioritized = new Set<string>();
  for (const item of candidates) {
    const scope = documentScope(subject, item.workspaceId, item.id, 'note');
    if (scope === undefined || !pendingScopes.has(scope)) continue;
    let ancestor: string | null = item.id;
    while (ancestor !== null && !prioritized.has(ancestor)) {
      prioritized.add(ancestor);
      ancestor = parentById.get(ancestor) ?? null;
    }
  }
  const orderedCandidates = [
    ...candidates.filter((item) => prioritized.has(item.id)),
    ...candidates.filter((item) => !prioritized.has(item.id)),
  ];
  let completed = 0;
  for (const item of orderedCandidates) {
    assertAccount(options);
    let existing = existingByServerId.get(item.id);
    let localId = item.id;
    if (existing !== undefined && existing.workspaceId !== item.workspaceId) {
      const oldScope = scopeFor(subject, existing, item.id);
      existing = await updateNote(
        existing.id,
        (current) => ({
          ...current,
          canWrite: false,
          blockedReason:
            'This note moved to another workspace. Local pending edits are preserved for recovery.',
        }),
        options,
      );
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      await flushLocalDraftsForScope(oldScope);
      const scopes = await listDraftScopes(subject);
      assertAccount(options);
      await sealItemBodies(subject, existing.workspaceId, item.id, 'refused');
      if (existing.pendingTitle !== null || scopes.includes(oldScope)) {
        downloaded.add(existing.id);
        localId = crypto.randomUUID();
        await updateNote(
          existing.id,
          (current) => ({
            ...current,
            canWrite: false,
            bodyAvailable: false,
            blockedReason:
              'This note moved to another workspace. Local pending edits are preserved for recovery.',
          }),
          options,
        );
      } else {
        await removeOfflineNote(existing.id, subject);
      }
      existing = undefined;
    }
    const parent = item.parentId === null ? undefined : existingByServerId.get(item.parentId);
    const parentId = parent?.workspaceId === item.workspaceId ? parent.id : item.parentId;
    const note: OfflineNote = existing ?? {
      id: localId,
      workspaceId: item.workspaceId,
      parentId,
      title: item.title,
      canWrite: false,
      bodyAvailable: false,
      publication: { kind: 'published', serverId: item.id, docId: '' },
      pendingTitle: null,
      blockedReason: null,
    };
    downloaded.add(note.id);
    let titleError: string | null = null;
    let titleWriteRefused = false;
    try {
      await applyPendingTitle(note, options);
    } catch (error) {
      assertAccount(options);
      if (
        sessionRefused(error) ||
        !isNixApiError(error) ||
        error.status === undefined ||
        error.status < 400 ||
        error.status >= 500 ||
        error.status === 429
      )
        throw error;
      if (refusalReason(error) === 'locked') {
        await sealItemBodies(subject, note.workspaceId, serverId(note), 'locked');
        await updateNote(
          note.id,
          (current) => ({
            ...current,
            canWrite: false,
            bodyAvailable: false,
            blockedReason: 'This note is locked. Local pending edits have been preserved.',
          }),
          options,
        );
        failures.push(`${item.title || 'Untitled note'}: ${errorMessage(error)}`);
        continue;
      }
      titleError = `The saved title could not be synchronized. Its queued change is preserved: ${errorMessage(error)}`;
      titleWriteRefused = error.status === 403;
      await updateNote(
        note.id,
        (current) => ({
          ...current,
          canWrite: titleWriteRefused ? false : current.canWrite,
          blockedReason: titleError,
        }),
        options,
      );
      failures.push(`${item.title || 'Untitled note'}: ${errorMessage(error)}`);
    }
    try {
      reopenRefusedItemBodies(subject, item.workspaceId, item.id);
      const body = await synchronizeBody(note, options);
      assertAccount(options);
      if (existing === undefined) {
        const saved: OfflineNote = {
          ...note,
          bodyAvailable: true,
          canWrite: body.canWrite && !titleWriteRefused,
          blockedReason: titleError,
          publication: { kind: 'published', serverId: item.id, docId: body.docId },
        };
        await saveOfflineNote(saved, subject);
        existingByServerId.set(item.id, saved);
      } else {
        const saved = await updateNote(
          note.id,
          (current) => ({
            ...current,
            workspaceId: item.workspaceId,
            parentId,
            title: current.pendingTitle ?? note.pendingTitle ?? item.title,
            canWrite: body.canWrite && !titleWriteRefused,
            bodyAvailable: true,
            blockedReason: titleError,
            publication: { kind: 'published', serverId: item.id, docId: body.docId },
          }),
          options,
        );
        existingByServerId.set(item.id, saved);
      }
      completed += 1;
      setOfflineProgress({ completed });
      if (body.assetError !== null) failures.push(`${item.title}: ${body.assetError}`);
    } catch (error) {
      assertAccount(options);
      if (sessionRefused(error)) throw error;
      failures.push(`${item.title || 'Untitled note'}: ${errorMessage(error)}`);
      if (refused(error)) {
        await sealItemBodies(subject, note.workspaceId, serverId(note), refusalReason(error));
      }
      if (existing !== undefined && refused(error)) {
        await updateNote(
          note.id,
          (current) => ({
            ...current,
            canWrite: false,
            bodyAvailable: false,
            blockedReason:
              'Access to this note is unavailable. Local pending edits have been preserved.',
          }),
          options,
        );
      }
    }
  }
  const missing = getOfflineSnapshot().notes.filter(
    (note) => note.publication.kind === 'published' && !downloaded.has(note.id),
  );
  const activeScopes = new Set(
    getOfflineSnapshot()
      .notes.filter(
        (note) =>
          downloaded.has(note.id) && note.publication.kind === 'published' && note.bodyAvailable,
      )
      .map((note) => scopeFor(subject, note, serverId(note))),
  );
  const missingScopes = new Map(
    missing.map((note) => [scopeFor(subject, note, serverId(note)), note]),
  );
  for (const note of missing) {
    assertAccount(options);
    await updateNote(
      note.id,
      (current) => ({
        ...current,
        canWrite: false,
        blockedReason:
          current.blockedReason ??
          'This note is no longer available from Nix. Local pending edits have been preserved.',
      }),
      options,
    );
  }
  if (missing.length > 0)
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  for (const [scope, note] of missingScopes) {
    assertAccount(options);
    await flushLocalDraftsForScope(scope);
    assertAccount(options);
    if (!activeScopes.has(scope))
      await sealItemBodies(subject, note.workspaceId, serverId(note), 'refused');
  }
  const draftScopes = new Set(await listDraftScopes(subject));
  for (const missingNote of missing) {
    assertAccount(options);
    const note = await getPersistedOfflineNote(missingNote.id, subject);
    if (note === null) continue;
    if (note.pendingTitle !== null || draftScopes.has(scopeFor(subject, note, serverId(note)))) {
      await updateNote(
        note.id,
        (current) => ({
          ...current,
          bodyAvailable: false,
          canWrite: false,
          blockedReason:
            current.blockedReason ??
            'This note is no longer available from Nix. Local pending edits have been preserved.',
        }),
        options,
      );
    } else {
      await removeOfflineNote(note.id, subject);
    }
  }
  assertAccount(options);
  await awaitOfflineShell(signal);
  assertAccount(options);
  setOfflineProgress({
    status: failures.length === 0 ? 'ready' : 'error',
    error: failures.length === 0 ? null : failures.slice(0, 3).join('\n'),
    pending:
      draftScopes.size +
      getOfflineSnapshot().notes.filter(
        (note) => note.publication.kind !== 'published' || note.pendingTitle !== null,
      ).length,
    lastSyncedAt: failures.length === 0 ? Date.now() : getOfflineSnapshot().lastSyncedAt,
  });
}

export function OfflineRuntime(): null {
  const client = useApiClient();
  const { getAccessToken } = useAuth();
  const status = useSessionStore((state) => state.status);
  const subject = useSessionStore((state) => state.profile?.subject);
  const enabled = useOfflinePreference((state) => state.enabled);
  useEffect(
    () =>
      onBodyForgetting((forgetting) => {
        if (forgetting.kind === 'scope') markOfflineBodyUnavailable(forgetting.scope);
        if (forgetting.kind === 'item') markOfflineBodyUnavailable(forgetting.prefix);
      }),
    [],
  );
  useEffect(() => {
    // Device sync off: nothing is scheduled or fetched; the saved notes are left as they are.
    if (!enabled) return;
    const browserFeatures: {
      readonly locks?: LockManager;
      readonly storage?: Partial<Pick<StorageManager, 'persist'>>;
    } = navigator;
    let active: AbortController | null = null;
    let disposed = false;
    let rerun = false;
    let contended = false;
    let automaticTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleAutomatic = (): void => {
      clearTimeout(automaticTimer);
      if (disposed || status !== 'authenticated' || subject === undefined) return;
      automaticTimer = setTimeout(synchronize, 5 * 60_000);
    };
    const synchronize = (queueActive = false): void => {
      if (disposed) return;
      if (!navigator.onLine || status !== 'authenticated' || subject === undefined) {
        if (readOfflineAccount() !== null) setOfflineProgress({ status: 'offline' });
        scheduleAutomatic();
        return;
      }
      if (active !== null) {
        rerun ||= queueActive;
        return;
      }
      clearTimeout(automaticTimer);
      const controller = new AbortController();
      const accountEpoch = bodyCacheAccountEpoch(subject);
      active = controller;
      const run = async (): Promise<void> => {
        await synchronizeOfflineNotes({
          client,
          getAccessToken,
          subject,
          signal: controller.signal,
        });
      };
      const coordinated =
        browserFeatures.locks === undefined
          ? run()
          : browserFeatures.locks.request(
              'nix-offline-sync',
              { ifAvailable: true },
              async (lock) => {
                if (lock !== null) await run();
                else contended = true;
              },
            );
      void coordinated
        .catch((error: unknown) => {
          if (
            !disposed &&
            !controller.signal.aborted &&
            readOfflineAccount()?.subject === subject &&
            bodyCacheAccountEpoch(subject) === accountEpoch
          ) {
            setOfflineProgress({
              status: navigator.onLine ? 'error' : 'offline',
              error: errorMessage(error),
            });
          }
        })
        .finally(() => {
          active = null;
          if (
            disposed ||
            readOfflineAccount()?.subject !== subject ||
            bodyCacheAccountEpoch(subject) !== accountEpoch
          )
            return;
          if (rerun) {
            rerun = false;
            synchronize();
          } else if (contended) {
            // The lock was held (often by the pass this effect restart just aborted): try again soon
            // instead of leaving the status on "Syncing" for the whole five-minute interval.
            contended = false;
            automaticTimer = setTimeout(synchronize, 1_000);
          } else scheduleAutomatic();
        });
    };
    const wentOffline = (): void => {
      active?.abort();
      if (readOfflineAccount() !== null) setOfflineProgress({ status: 'offline', error: null });
    };
    const wentOnline = (): void => {
      synchronize(active?.signal.aborted === true);
    };
    const requested = (): void => {
      synchronize(true);
    };
    const readPending = (): void => {
      if (subject === undefined) return;
      const accountEpoch = bodyCacheAccountEpoch(subject);
      void listDraftScopes(subject)
        .then((scopes) => {
          if (
            disposed ||
            readOfflineAccount()?.subject !== subject ||
            bodyCacheAccountEpoch(subject) !== accountEpoch
          )
            return;
          setOfflineProgress({
            pending:
              scopes.length +
              getOfflineSnapshot().notes.filter(
                (note) => note.publication.kind !== 'published' || note.pendingTitle !== null,
              ).length,
          });
        })
        .catch(() => undefined);
    };
    const updatePending = (): void => {
      clearTimeout(pendingTimer);
      pendingTimer = setTimeout(readPending, 300);
    };
    if (status === 'authenticated' && browserFeatures.storage?.persist !== undefined)
      void browserFeatures.storage.persist().catch(() => false);
    synchronize();
    readPending();
    window.addEventListener('online', wentOnline);
    window.addEventListener('offline', wentOffline);
    window.addEventListener(SYNC_EVENT, requested);
    window.addEventListener('nix:offline-drafts-changed', updatePending);
    return () => {
      disposed = true;
      active?.abort();
      clearTimeout(automaticTimer);
      clearTimeout(pendingTimer);
      window.removeEventListener('online', wentOnline);
      window.removeEventListener('offline', wentOffline);
      window.removeEventListener(SYNC_EVENT, requested);
      window.removeEventListener('nix:offline-drafts-changed', updatePending);
    };
  }, [client, enabled, getAccessToken, status, subject]);
  return null;
}
