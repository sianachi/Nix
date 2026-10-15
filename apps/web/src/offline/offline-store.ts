import { NoteStorageClosed, noteTransaction, type NoteTable } from '../lib/note-database';
import { workspaceSchema, type Workspace } from '@nix/api-client';
import { SCHEMA_VERSION } from '@nix/editor-schema';
import * as Y from 'yjs';
import { z } from 'zod';
import type { SessionProfile } from '../auth/session-store';
import {
  bodyCacheAccountEpoch,
  bodyCacheCleanupCurrent,
  documentScope,
  readBodyCache,
  writeBodyCache,
} from '../editor/body-cache';
import { browserStorage } from '../lib/browser-storage';
const ACCOUNT_KEY = 'nix.offline.account';
const CHANGE_KEY = 'nix.offline.changed';
const profileSchema = z.object({
  subject: z.string().min(1),
  name: z.string(),
  email: z.string().nullable(),
});
const noteSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  parentId: z.string().nullable(),
  title: z.string(),
  canWrite: z.boolean(),
  bodyAvailable: z.boolean(),
  publication: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('published'), serverId: z.string(), docId: z.string() }),
    z.object({
      kind: z.literal('publishing'),
      serverId: z.string(),
      docId: z.string().nullable(),
      key: z.string(),
      originalTitle: z.string(),
      originalParentId: z.string().nullable(),
    }),
    z.object({
      kind: z.literal('pending'),
      key: z.string(),
      originalTitle: z.string(),
      originalParentId: z.string().nullable(),
    }),
  ]),
  pendingTitle: z.string().nullable(),
  blockedReason: z.string().nullable(),
});
export type OfflineNote = z.infer<typeof noteSchema>;
export interface OfflineSnapshot {
  readonly account: SessionProfile | null;
  readonly workspaces: readonly Workspace[];
  readonly notes: readonly OfflineNote[];
  readonly status: 'loading' | 'idle' | 'downloading' | 'syncing' | 'ready' | 'offline' | 'error';
  readonly completed: number;
  readonly total: number;
  readonly pending: number;
  readonly error: string | null;
  readonly lastSyncedAt: number | null;
}
let snapshot: OfflineSnapshot = {
  account: null,
  workspaces: [],
  notes: [],
  status: 'idle',
  completed: 0,
  total: 0,
  pending: 0,
  error: null,
  lastSyncedAt: null,
};
const listeners = new Set<() => void>();
let generation = 0;
let revision = 0;
let accountForgotten = false;
let channel: BroadcastChannel | undefined;
const storedNoteSchema = z.object({ key: z.string(), subject: z.string(), note: noteSchema });
const forgottenSchema = z.object({
  kind: z.literal('forgotten'),
  subject: z.string().nullable(),
  epoch: z.string().nullable(),
});
function emit(): void {
  for (const listener of listeners) listener();
}
function reportStorageError(cause: unknown): void {
  setOfflineProgress({
    status: 'error',
    error: storageError(cause).message,
  });
}
function storageError(cause: unknown): Error {
  return cause instanceof Error
    ? cause
    : new Error(cause instanceof DOMException ? cause.message : 'Offline storage failed.', {
        cause,
      });
}
function refreshFromAnotherTab(): void {
  const profile = readOfflineAccount();
  if (profile?.subject !== snapshot.account?.subject) {
    generation += 1;
    resetSnapshot();
  }
  if (profile !== null) void loadOfflineNotes().catch(reportStorageError);
}
function onStorage(event: StorageEvent): void {
  if (event.key === ACCOUNT_KEY || event.key === CHANGE_KEY || event.key === null)
    refreshFromAnotherTab();
}
function notifyTabs(
  message: 'changed' | 'forgotten' = 'changed',
  subject: string | null = null,
  epoch: string | null = null,
): void {
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const outgoing = channel ?? new BroadcastChannel('nix-offline-notes');
      outgoing.postMessage(message === 'forgotten' ? { kind: message, subject, epoch } : message);
      if (outgoing !== channel) outgoing.close();
    } else {
      browserStorage()?.setItem(CHANGE_KEY, crypto.randomUUID());
    }
  } catch {
    /* A notification failure must not reject a completed durable save. */
  }
}
function resetSnapshot(): void {
  snapshot = {
    account: null,
    workspaces: [],
    notes: [],
    status: 'idle',
    completed: 0,
    total: 0,
    pending: 0,
    error: null,
    lastSyncedAt: null,
  };
  emit();
}
export function readOfflineAccount(): SessionProfile | null {
  if (accountForgotten) return null;
  try {
    const raw = browserStorage()?.getItem(ACCOUNT_KEY);
    return raw == null ? null : profileSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}
export function getOfflineSnapshot(): OfflineSnapshot {
  return snapshot;
}
export function subscribeOfflineNotes(listener: () => void): () => void {
  if (listeners.size === 0) {
    window.addEventListener('storage', onStorage);
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel('nix-offline-notes');
      channel.onmessage = (event) => {
        const forgotten = forgottenSchema.safeParse(event.data);
        const current = readOfflineAccount();
        if (
          forgotten.success &&
          forgotten.data.subject !== null &&
          !bodyCacheCleanupCurrent(forgotten.data.subject, forgotten.data.epoch)
        )
          return;
        if (
          forgotten.success &&
          (forgotten.data.subject === null ||
            current === null ||
            current.subject === forgotten.data.subject)
        ) {
          accountForgotten = true;
          generation += 1;
          resetSnapshot();
        } else {
          refreshFromAnotherTab();
        }
      };
    }
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener('storage', onStorage);
      channel?.close();
      channel = undefined;
    }
  };
}
export function setOfflineProgress(
  change: Partial<Omit<OfflineSnapshot, 'account' | 'notes' | 'workspaces'>>,
): void {
  snapshot = { ...snapshot, ...change };
  emit();
}
async function transaction<T>(
  storeName: 'notes' | 'workspaces',
  subject: string | null,
  mode: IDBTransactionMode,
  run: (
    store: NoteTable,
    done: (result: T) => void,
    fail: (cause: unknown) => never,
  ) => Promise<void>,
): Promise<T> {
  const current = generation;
  const epoch = subject === null ? null : bodyCacheAccountEpoch(subject);
  const admitted = (): boolean =>
    subject === null ||
    (current === generation &&
      readOfflineAccount()?.subject === subject &&
      bodyCacheCleanupCurrent(subject, epoch));
  return noteTransaction('nix-offline-notes', storeName, mode, admitted, async (tx) => {
    let completion:
      | {
          value: T;
        }
      | undefined;
    await run(
      tx.table(storeName),
      (value) => {
        completion = { value };
      },
      (cause) => {
        throw storageError(cause);
      },
    );
    if (completion === undefined) throw new Error('Offline storage returned no result.');
    return completion.value;
  }).catch((error: unknown) => {
    if (error instanceof NoteStorageClosed) throw new Error('The offline account changed.');
    throw error;
  });
}
function account(expectedSubject?: string): SessionProfile {
  const profile = readOfflineAccount();
  if (profile === null) throw new Error('Sign in before saving notes on this device.');
  if (expectedSubject !== undefined && profile.subject !== expectedSubject)
    throw new Error('The offline account changed.');
  return profile;
}
const keyFor = (subject: string, id: string): string => JSON.stringify([subject, id]);
export async function loadOfflineNotes(): Promise<void> {
  const profile = readOfflineAccount();
  const current = generation;
  const beforeRead = revision;
  if (profile === null) {
    resetSnapshot();
    return;
  }
  const [storedNotes, storedWorkspaces] = await Promise.all([
    transaction(
      'notes',
      profile.subject,
      'readonly',
      async (store, done: (records: unknown) => void) => {
        const request = await store.index('subject').getAll(profile.subject);
        done(request);
      },
    ),
    transaction(
      'workspaces',
      profile.subject,
      'readonly',
      async (store, done: (record: unknown) => void) => {
        const request = await store.get(profile.subject);
        done(request);
      },
    ),
  ]);
  if (
    current !== generation ||
    beforeRead !== revision ||
    readOfflineAccount()?.subject !== profile.subject
  )
    return;
  const notes = z
    .array(storedNoteSchema)
    .parse(storedNotes)
    .map((record) => record.note);
  const workspaces =
    storedWorkspaces === undefined
      ? []
      : z.object({ workspaces: z.array(workspaceSchema) }).parse(storedWorkspaces).workspaces;
  snapshot = { ...snapshot, account: profile, notes, workspaces };
  emit();
}
export async function rememberOfflineAccount(profile: SessionProfile): Promise<void> {
  const validated = profileSchema.parse(profile);
  const previous = readOfflineAccount();
  if (previous !== null && previous.subject !== profile.subject) {
    const clearing = clearOfflineData(previous.subject);
    const current = generation;
    await clearing;
    if (current !== generation) throw new Error('The offline account changed.');
  }
  const storage = browserStorage();
  if (storage === undefined)
    throw new Error('Offline account storage is unavailable on this device.');
  storage.setItem(ACCOUNT_KEY, JSON.stringify(validated));
  accountForgotten = false;
  if (snapshot.account?.subject !== validated.subject) {
    generation += 1;
    resetSnapshot();
  }
  snapshot = { ...snapshot, account: validated };
  notifyTabs();
  await loadOfflineNotes();
}
export function forgetOfflineAccount(
  expectedSubject?: string,
  expectedEpoch?: string | null,
): void {
  const current = readOfflineAccount();
  const departing = expectedSubject ?? current?.subject ?? snapshot.account?.subject ?? null;
  const epoch =
    expectedEpoch === undefined
      ? departing === null
        ? null
        : bodyCacheAccountEpoch(departing)
      : expectedEpoch;
  if (expectedSubject !== undefined && !bodyCacheCleanupCurrent(expectedSubject, epoch)) return;
  if (expectedSubject !== undefined && current?.subject !== expectedSubject) {
    if (snapshot.account?.subject === expectedSubject) {
      generation += 1;
      resetSnapshot();
    }
    return;
  }
  generation += 1;
  accountForgotten = true;
  try {
    browserStorage()?.removeItem(ACCOUNT_KEY);
  } catch {
    /* Stay closed even when storage removal fails. */
  }
  resetSnapshot();
  notifyTabs('forgotten', departing, epoch);
}
export async function clearOfflineData(
  expectedSubject?: string,
  expectedEpoch?: string | null,
): Promise<void> {
  const epoch =
    expectedEpoch === undefined && expectedSubject !== undefined
      ? bodyCacheAccountEpoch(expectedSubject)
      : (expectedEpoch ?? null);
  if (expectedSubject === undefined) forgetOfflineAccount();
  else forgetOfflineAccount(expectedSubject, epoch);
  await Promise.all(
    ['notes', 'workspaces'].map((store) =>
      transaction(
        store === 'notes' ? 'notes' : 'workspaces',
        null,
        'readwrite',
        async (records, done) => {
          if (expectedSubject !== undefined && !bodyCacheCleanupCurrent(expectedSubject, epoch)) {
            done(undefined);
            return;
          }
          if (expectedSubject === undefined) {
            await records.clear();
            done(undefined);
          } else if (store === 'workspaces') {
            await records.delete(expectedSubject);
            done(undefined);
          } else {
            for (const current of await records
              .index('subject')
              .entries(expectedSubject, undefined, true)) {
              await records.delete(current.primaryKey);
            }
            done(undefined);
          }
        },
      ),
    ),
  );
  notifyTabs();
}
export async function saveOfflineWorkspaces(
  workspaces: readonly Workspace[],
  expectedSubject?: string,
): Promise<void> {
  const profile = account(expectedSubject);
  const current = generation;
  const validated = z.array(workspaceSchema).parse(workspaces);
  await transaction('workspaces', profile.subject, 'readwrite', async (store, done) => {
    await store.put({ subject: profile.subject, workspaces: validated });
    done(undefined);
  });
  if (current !== generation || readOfflineAccount()?.subject !== profile.subject)
    throw new Error('The offline account changed.');
  revision += 1;
  snapshot = { ...snapshot, workspaces: validated };
  emit();
  notifyTabs();
}
function noteSaved(profile: SessionProfile, note: OfflineNote, current: number): void {
  if (current !== generation || readOfflineAccount()?.subject !== profile.subject)
    throw new Error('The offline account changed.');
  revision += 1;
  snapshot = {
    ...snapshot,
    notes: [...snapshot.notes.filter((existing) => existing.id !== note.id), note],
  };
  emit();
  notifyTabs();
}
export async function saveOfflineNote(note: OfflineNote, expectedSubject?: string): Promise<void> {
  const profile = account(expectedSubject);
  const current = generation;
  const validated = noteSchema.parse(note);
  await transaction('notes', profile.subject, 'readwrite', async (store, done) => {
    await store.put({
      key: keyFor(profile.subject, note.id),
      subject: profile.subject,
      note: validated,
    });
    done(undefined);
  });
  noteSaved(profile, validated, current);
}
export async function getPersistedOfflineNote(
  id: string,
  expectedSubject?: string,
): Promise<OfflineNote | null> {
  const profile = account(expectedSubject);
  const current = generation;
  const raw = await transaction(
    'notes',
    profile.subject,
    'readonly',
    async (store, done: (value: unknown) => void) => {
      const request = await store.get(keyFor(profile.subject, id));
      done(request);
    },
  );
  if (current !== generation || readOfflineAccount()?.subject !== profile.subject)
    throw new Error('The offline account changed.');
  return raw === undefined ? null : storedNoteSchema.parse(raw).note;
}
export async function updateOfflineNote(
  id: string,
  change: (note: OfflineNote) => OfflineNote,
  expectedSubject?: string,
): Promise<OfflineNote> {
  const profile = account(expectedSubject);
  const current = generation;
  const updated = await transaction(
    'notes',
    profile.subject,
    'readwrite',
    async (store, done: (value: OfflineNote) => void, fail) => {
      const request = await store.get(keyFor(profile.subject, id));
      try {
        if (request === undefined) throw new Error('This note is no longer saved on this device.');
        const current = storedNoteSchema.parse(request).note;
        const next = noteSchema.parse(change(current));
        if (next.id !== current.id || next.workspaceId !== current.workspaceId)
          throw new Error('A saved note cannot change its identity.');
        await store.put({ key: keyFor(profile.subject, id), subject: profile.subject, note: next });
        done(next);
      } catch (cause) {
        fail(cause);
      }
    },
  );
  noteSaved(profile, updated, current);
  return updated;
}
export async function removeOfflineNote(id: string, expectedSubject?: string): Promise<void> {
  const profile = account(expectedSubject);
  const current = generation;
  await transaction('notes', profile.subject, 'readwrite', async (store, done) => {
    await store.delete(keyFor(profile.subject, id));
    done(undefined);
  });
  if (current !== generation || readOfflineAccount()?.subject !== profile.subject)
    throw new Error('The offline account changed.');
  revision += 1;
  snapshot = { ...snapshot, notes: snapshot.notes.filter((note) => note.id !== id) };
  emit();
  notifyTabs();
}
export function markOfflineBodyUnavailable(scopeOrPrefix: string): void {
  const profile = readOfflineAccount();
  if (profile === null) return;
  const current = generation;
  const matches = (note: OfflineNote): boolean =>
    note.publication.kind === 'published' &&
    (documentScope(
      profile.subject,
      note.workspaceId,
      note.publication.serverId,
      'note',
    )?.startsWith(scopeOrPrefix) ??
      false);
  const disable = (note: OfflineNote): OfflineNote =>
    matches(note)
      ? {
          ...note,
          bodyAvailable: false,
          canWrite: false,
          blockedReason: 'This saved copy is unavailable. Reconnect to Nix to check access.',
        }
      : note;
  const matched = snapshot.notes.filter(matches);
  if (matched.length === 0) return;
  revision += 1;
  snapshot = { ...snapshot, notes: snapshot.notes.map(disable) };
  emit();
  void Promise.all(
    matched.map((note) => updateOfflineNote(note.id, disable, profile.subject)),
  ).catch((cause: unknown) => {
    if (current === generation && readOfflineAccount()?.subject === profile.subject)
      reportStorageError(cause);
  });
}
export async function createOfflineNote(
  workspaceId: string,
  parentId: string | null,
  title: string,
  expectedSubject?: string,
): Promise<OfflineNote> {
  const profile = account(expectedSubject);
  const current = generation;
  const epoch = bodyCacheAccountEpoch(profile.subject);
  if (!snapshot.workspaces.some((workspace) => workspace.id === workspaceId))
    throw new Error('This workspace has not been downloaded.');
  const cleaned = title.trim();
  if (!cleaned || cleaned.length > 255)
    throw new Error('Use a note title between 1 and 255 characters.');
  if (
    parentId !== null &&
    !snapshot.notes.some(
      (note) =>
        note.id === parentId &&
        note.workspaceId === workspaceId &&
        note.canWrite &&
        note.blockedReason === null,
    )
  )
    throw new Error('Choose an available note as the destination.');
  const id = crypto.randomUUID();
  const scope = documentScope(profile.subject, workspaceId, id, 'note');
  if (scope === undefined) throw new Error('The note has no local storage scope.');
  const doc = new Y.Doc();
  try {
    await writeBodyCache({
      scope,
      docId: `local:${id}`,
      schemaVersion: SCHEMA_VERSION,
      savedAt: Date.now(),
      update: Y.encodeStateAsUpdate(doc),
    });
    if ((await readBodyCache(scope))?.docId !== `local:${id}`)
      throw new Error('The new note could not be saved on this device.');
  } finally {
    doc.destroy();
  }
  if (
    current !== generation ||
    readOfflineAccount()?.subject !== profile.subject ||
    !bodyCacheCleanupCurrent(profile.subject, epoch)
  )
    throw new Error('The offline account changed.');
  const note: OfflineNote = {
    id,
    workspaceId,
    parentId,
    title: cleaned,
    canWrite: true,
    bodyAvailable: true,
    publication: {
      kind: 'pending',
      key: crypto.randomUUID(),
      originalTitle: cleaned,
      originalParentId: parentId,
    },
    pendingTitle: null,
    blockedReason: null,
  };
  await saveOfflineNote(note, profile.subject);
  return note;
}
export async function renameOfflineNote(
  id: string,
  title: string,
  expectedSubject?: string,
): Promise<void> {
  const profile = account(expectedSubject);
  const cleaned = title.trim();
  if (!cleaned || cleaned.length > 255)
    throw new Error('Use a note title between 1 and 255 characters.');
  await updateOfflineNote(
    id,
    (note) => {
      if (!note.canWrite || note.blockedReason !== null)
        throw new Error('This note cannot be changed on this device.');
      return { ...note, title: cleaned, pendingTitle: cleaned };
    },
    profile.subject,
  );
}
