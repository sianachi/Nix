import { NoteStorageClosed, noteTransaction, type NoteTable } from '../lib/note-database';
import { files, isNixApiError, locks, type NixClient } from '@nix/api-client';
import {
  createContext,
  createElement,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import * as Y from 'yjs';
import { z } from 'zod';
import {
  bodyCacheAdmits,
  bodyCacheAccountEpoch,
  bodyCacheCleanupCurrent,
  documentScope,
  onBodyForgetting,
  type BodyForgetting,
} from '../editor/body-cache';
import { FRAGMENT_NAME } from '../editor/collab-sync';
import { browserStorage } from '../lib/browser-storage';
const assetSchema = z.object({
  key: z.string(),
  scope: z.string(),
  fileItemId: z.string(),
  sha256: z.string(),
  mediaType: z.string(),
  blob: z.custom<Blob>((value) => Object.prototype.toString.call(value) === '[object Blob]'),
});
let generation = 0;
let cleanup = Promise.resolve();
const listeners = new Set<() => void>();
const sealedFiles = new Set<string>();
const REFUSAL_PREFIX = 'nix.offline-note-assets.refused:';
const SUBJECT_MARKER = 'nix.offline-note-assets.subject';
let admissionFailed = false;
const failedSubjects = new Set<string>();
let admissionOpening: Promise<void> | undefined;
let channel: BroadcastChannel | undefined;
const messageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('refused'), subject: z.string(), fileItemId: z.string() }),
  z.object({ kind: z.literal('authorized'), subject: z.string(), fileItemId: z.string() }),
  z.object({
    kind: z.literal('closed'),
    expectedSubject: z.string().optional(),
    epoch: z.string().nullable().optional(),
  }),
]);
type AssetMessage = z.infer<typeof messageSchema>;
const scopeSchema = z.tuple([z.string(), z.string(), z.string(), z.string()]);
function scopeParts(scope: string): z.infer<typeof scopeSchema> | null {
  try {
    const parsed = scopeSchema.safeParse(JSON.parse(scope));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
const fileKey = (subject: string, fileItemId: string): string =>
  JSON.stringify([subject, fileItemId]);
function invalidate(): void {
  generation += 1;
  for (const listener of listeners) listener();
}
function broadcast(message: AssetMessage): void {
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const outgoing = channel ?? new BroadcastChannel('nix-offline-note-assets');
    outgoing.postMessage(message);
    if (outgoing !== channel) outgoing.close();
  } catch {
    // The durable storage event also invalidates other tabs.
  }
}
function receive(raw: unknown): void {
  const parsed = messageSchema.safeParse(raw);
  if (!parsed.success) return;
  const message = parsed.data;
  if (message.kind === 'refused') sealedFiles.add(fileKey(message.subject, message.fileItemId));
  if (message.kind === 'authorized')
    sealedFiles.delete(fileKey(message.subject, message.fileItemId));
  const owner = currentAssetSubject();
  if (message.kind === 'closed') {
    if (message.expectedSubject === undefined) admissionFailed = true;
    else {
      if (!bodyCacheCleanupCurrent(message.expectedSubject, message.epoch ?? null)) return;
      if (owner !== null && owner !== message.expectedSubject) return;
      failedSubjects.add(message.expectedSubject);
    }
  } else if (owner !== message.subject) return;
  invalidate();
}
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === null || event.key === SUBJECT_MARKER) {
      if (event.key === SUBJECT_MARKER && event.newValue !== currentAssetSubject()) return;
      if (event.key === SUBJECT_MARKER && event.newValue !== null) {
        admissionFailed = false;
        failedSubjects.delete(event.newValue);
      }
      invalidate();
      return;
    }
    if (!event.key.startsWith(REFUSAL_PREFIX)) return;
    try {
      const identity = z
        .tuple([z.string(), z.string()])
        .safeParse(JSON.parse(event.key.slice(REFUSAL_PREFIX.length)));
      if (identity.success)
        receive({
          kind: event.newValue === null ? 'authorized' : 'refused',
          subject: identity.data[0],
          fileItemId: identity.data[1],
        });
    } catch {
      invalidate();
    }
  });
}
function assetsAdmit(subject: string, fileItemId?: string): boolean {
  if (admissionFailed || failedSubjects.has(subject)) return false;
  try {
    const storage = browserStorage();
    return (
      storage?.getItem(SUBJECT_MARKER) === subject &&
      (fileItemId === undefined ||
        (!sealedFiles.has(fileKey(subject, fileItemId)) &&
          storage.getItem(`${REFUSAL_PREFIX}${fileKey(subject, fileItemId)}`) === null))
    );
  } catch {
    return false;
  }
}
function currentAssetSubject(): string | null {
  try {
    return browserStorage()?.getItem(SUBJECT_MARKER) ?? null;
  } catch {
    return null;
  }
}
function closeAdmission(
  expectedSubject?: string,
  epoch = expectedSubject === undefined ? null : bodyCacheAccountEpoch(expectedSubject),
): Error | undefined {
  if (expectedSubject !== undefined && !bodyCacheCleanupCurrent(expectedSubject, epoch))
    return undefined;
  try {
    const storage = browserStorage();
    if (storage === undefined) throw new Error('Offline image admission storage is unavailable.');
    if (expectedSubject !== undefined && storage.getItem(SUBJECT_MARKER) !== expectedSubject)
      return undefined;
    storage.removeItem(SUBJECT_MARKER);
    invalidate();
    broadcast({ kind: 'closed', expectedSubject, epoch });
    return undefined;
  } catch (cause) {
    if (expectedSubject === undefined) admissionFailed = true;
    else failedSubjects.add(expectedSubject);
    invalidate();
    broadcast({ kind: 'closed', expectedSubject, epoch });
    return new Error(
      'Offline image access could not be closed. Reload after repairing browser storage.',
      { cause },
    );
  }
}
function refuseFile(subject: string, fileItemId: string): Error | undefined {
  sealedFiles.add(fileKey(subject, fileItemId));
  invalidate();
  broadcast({ kind: 'refused', subject, fileItemId });
  try {
    const storage = browserStorage();
    if (storage === undefined) throw new Error('Offline image admission storage is unavailable.');
    storage.setItem(`${REFUSAL_PREFIX}${fileKey(subject, fileItemId)}`, 'refused');
    return undefined;
  } catch (cause) {
    failedSubjects.add(subject);
    const closingError = closeAdmission(subject);
    return new Error(
      'This image could not be durably refused. Offline images are disabled until storage is repaired.',
      {
        cause: closingError ?? cause,
      },
    );
  }
}
function authorizeFile(subject: string, fileItemId: string): void {
  const identity = fileKey(subject, fileItemId);
  try {
    const storage = browserStorage();
    if (storage === undefined) throw new Error('Offline image admission storage is unavailable.');
    const refused =
      sealedFiles.has(identity) || storage.getItem(`${REFUSAL_PREFIX}${identity}`) !== null;
    storage.removeItem(`${REFUSAL_PREFIX}${identity}`);
    sealedFiles.delete(identity);
    if (refused) {
      invalidate();
      broadcast({ kind: 'authorized', subject, fileItemId });
    }
  } catch (cause) {
    failedSubjects.add(subject);
    closeAdmission(subject);
    throw new Error('Offline image authorization could not be saved.', { cause });
  }
}
async function ensureAdmission(subject: string, admitted: () => boolean): Promise<void> {
  if (admissionFailed || failedSubjects.has(subject))
    throw new Error('Offline images are disabled until browser storage is repaired.');
  if (assetsAdmit(subject)) return;
  if (admissionOpening === undefined) {
    const opening = (async () => {
      // An absent gate may follow a failed refusal write. Remove old bytes before reopening it.
      await transaction(
        'readwrite',
        async (store, done) => {
          await store.clear();
          done(undefined);
        },
        undefined,
        admitted,
      );
      if (!admitted()) throw new Error('This note is no longer available offline.');
      const storage = browserStorage();
      if (storage === undefined) throw new Error('Offline image admission storage is unavailable.');
      storage.setItem(SUBJECT_MARKER, subject);
    })();
    admissionOpening = opening;
    void opening
      .finally(() => {
        if (admissionOpening === opening) admissionOpening = undefined;
      })
      .catch(() => undefined);
  }
  await admissionOpening;
  if (!assetsAdmit(subject)) throw new Error('Offline image access could not be opened.');
}
async function transaction<T>(
  mode: IDBTransactionMode,
  run: (store: NoteTable, done: (value: T) => void) => Promise<void>,
  initial: T,
  admitted: () => boolean = () => true,
): Promise<T> {
  return noteTransaction('nix-offline-note-assets', 'assets', mode, admitted, async (tx) => {
    let result = initial;
    await run(tx.table('assets'), (value) => {
      result = value;
    });
    return result;
  }).catch((error: unknown) => {
    if (error instanceof NoteStorageClosed)
      throw new Error('This note is no longer available offline.');
    throw error;
  });
}
const key = (scope: string, fileItemId: string): string => JSON.stringify([scope, fileItemId]);
async function discardFile(scope: string, fileItemId: string): Promise<void> {
  const subject = scopeParts(scope)?.[0];
  if (subject === undefined) return;
  const refusalError = refuseFile(subject, fileItemId);
  await transaction(
    'readwrite',
    async (store, done) => {
      for (const entry of await store.entries()) {
        const parsed = assetSchema.safeParse(entry.value);
        if (
          !parsed.success ||
          (scopeParts(parsed.data.scope)?.[0] === subject && parsed.data.fileItemId === fileItemId)
        )
          await store.delete(entry.primaryKey);
      }
      done(undefined);
    },
    undefined,
  );
  if (refusalError !== undefined) throw refusalError;
}
export async function readOfflineNoteAsset(
  scope: string,
  fileItemId: string,
): Promise<Blob | null> {
  const current = generation;
  const subject = scopeParts(scope)?.[0];
  if (!bodyCacheAdmits(scope) || subject === undefined || !assetsAdmit(subject, fileItemId))
    return null;
  await cleanup;
  if (current !== generation || !bodyCacheAdmits(scope) || !assetsAdmit(subject, fileItemId))
    return null;
  const raw: unknown = await transaction<unknown>(
    'readonly',
    async (store, done) => {
      const request = await store.get(key(scope, fileItemId));
      done(request);
    },
    undefined,
  );
  if (current !== generation || !bodyCacheAdmits(scope) || !assetsAdmit(subject, fileItemId))
    return null;
  const parsed = assetSchema.safeParse(raw);
  if (!parsed.success || parsed.data.scope !== scope || parsed.data.fileItemId !== fileItemId)
    return null;
  return parsed.data.blob;
}
function imageFileIds(doc: Y.Doc): Set<string> {
  const ids = new Set<string>();
  const walk = (node: Y.XmlFragment | Y.XmlElement): void => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      const fileItemId: unknown = child.getAttribute('fileItemId');
      if (child.nodeName === 'image' && typeof fileItemId === 'string' && fileItemId.length > 0)
        ids.add(fileItemId);
      walk(child);
    }
  };
  walk(doc.getXmlFragment(FRAGMENT_NAME));
  return ids;
}
export async function cacheOfflineNoteAssets(
  doc: Y.Doc,
  subject: string,
  workspaceId: string,
  itemId: string,
  client: NixClient,
  signal?: AbortSignal,
): Promise<void> {
  const scope = documentScope(subject, workspaceId, itemId, 'note');
  if (scope === undefined) throw new Error('Offline images have no note scope.');
  let current = generation;
  const ids = imageFileIds(doc);
  const bodyAdmitted = (): boolean => bodyCacheAdmits(scope) && current === generation;
  await cleanup;
  await ensureAdmission(subject, bodyAdmitted);
  const admitted = (): boolean => bodyAdmitted() && assetsAdmit(subject);
  for (const fileItemId of ids) {
    signal?.throwIfAborted();
    if (!admitted()) throw new Error('This note is no longer available offline.');
    try {
      const lock = await client.query(locks.getItemLock(fileItemId), {
        signal,
        forceRefresh: true,
      });
      if (lock.locked) {
        await discardFile(scope, fileItemId);
        throw new Error('A password-protected image cannot be downloaded for offline use.');
      }
      const currentCapability = await client.query(
        files.downloadFile(fileItemId, undefined, true),
        { signal, forceRefresh: true },
      );
      const present = await transaction(
        'readonly',
        async (store, done) => {
          const request = await store
            .index('version')
            .getKey([scope, fileItemId, currentCapability.sha256]);
          done(request !== undefined);
        },
        false,
        admitted,
      );
      if (present) {
        const latestLock = await client.query(locks.getItemLock(fileItemId), {
          signal,
          forceRefresh: true,
        });
        if (latestLock.locked) {
          await discardFile(scope, fileItemId);
          throw new Error('A password-protected image cannot be downloaded for offline use.');
        }
        if (!admitted()) throw new Error('This note is no longer available offline.');
        authorizeFile(subject, fileItemId);
        current = generation;
        continue;
      }
      const { blob, capability } = await files.fetchFileContent(
        client,
        fileItemId,
        undefined,
        true,
        signal,
      );
      signal?.throwIfAborted();
      const latestLock = await client.query(locks.getItemLock(fileItemId), {
        signal,
        forceRefresh: true,
      });
      if (latestLock.locked) {
        await discardFile(scope, fileItemId);
        throw new Error('A password-protected image cannot be downloaded for offline use.');
      }
      await transaction(
        'readwrite',
        async (store, done) => {
          await store.put({
            key: key(scope, fileItemId),
            scope,
            fileItemId,
            sha256: capability.sha256,
            mediaType: blob.type || capability.mediaType,
            blob,
          });
          done(undefined);
        },
        undefined,
        admitted,
      );
      if (!admitted()) throw new Error('This note is no longer available offline.');
      authorizeFile(subject, fileItemId);
      current = generation;
    } catch (cause) {
      if (
        isNixApiError(cause) &&
        (cause.status === 401 ||
          cause.status === 403 ||
          cause.status === 404 ||
          cause.status === 423)
      )
        await discardFile(scope, fileItemId);
      throw cause;
    }
  }
  if (!admitted()) throw new Error('This note is no longer available offline.');
  await transaction(
    'readwrite',
    async (store, done) => {
      for (const entry of await store.index('scope').entries(IDBKeyRange.only(scope))) {
        const parsed = assetSchema.safeParse(entry.value);
        if (!parsed.success || !ids.has(parsed.data.fileItemId))
          await store.delete(entry.primaryKey);
      }
      done(undefined);
    },
    undefined,
    admitted,
  );
}
function forget(forgetting: BodyForgetting): void {
  const expectedSubject = forgetting.kind === 'everything' ? forgetting.subject : undefined;
  const epoch = forgetting.kind === 'everything' ? (forgetting.epoch ?? null) : null;
  const cleanupAdmitted = (): boolean =>
    expectedSubject === undefined || bodyCacheCleanupCurrent(expectedSubject, epoch);
  if (!cleanupAdmitted()) return;
  const itemScope =
    forgetting.kind === 'item'
      ? scopeParts(`${forgetting.prefix}"note"]`)
      : forgetting.kind === 'scope'
        ? scopeParts(forgetting.scope)
        : null;
  const admissionError =
    forgetting.kind === 'everything'
      ? closeAdmission(expectedSubject, epoch)
      : itemScope !== null
        ? refuseFile(itemScope[0], itemScope[2])
        : undefined;
  if (forgetting.kind === 'unreachable') invalidate();
  cleanup = cleanup
    .catch(() => undefined)
    .then(async () => {
      if (!cleanupAdmitted()) return;
      try {
        await transaction(
          'readwrite',
          async (store, done) => {
            if (forgetting.kind === 'everything' && expectedSubject === undefined) {
              await store.clear();
              done(undefined);
              return;
            }
            for (const entry of await store.entries()) {
              const parsed = assetSchema.safeParse(entry.value);
              const scope = parsed.success ? parsed.data.scope : null;
              let remove = scope === null && expectedSubject === undefined;
              if (scope !== null) {
                switch (forgetting.kind) {
                  case 'everything':
                    remove = scopeParts(scope)?.[0] === expectedSubject;
                    break;
                  case 'scope':
                    remove =
                      scope === forgetting.scope ||
                      (itemScope !== null &&
                        scopeParts(scope)?.[0] === itemScope[0] &&
                        parsed.success &&
                        parsed.data.fileItemId === itemScope[2]);
                    break;
                  case 'item':
                    remove =
                      scope.startsWith(forgetting.prefix) ||
                      (itemScope !== null &&
                        scopeParts(scope)?.[0] === itemScope[0] &&
                        parsed.success &&
                        parsed.data.fileItemId === itemScope[2]);
                    break;
                  case 'unreachable': {
                    try {
                      const parts: unknown = JSON.parse(scope);
                      remove =
                        !Array.isArray(parts) ||
                        parts[0] !== forgetting.subject ||
                        typeof parts[1] !== 'string' ||
                        !forgetting.reachableWorkspaceIds.has(parts[1]);
                    } catch {
                      remove = true;
                    }
                    break;
                  }
                }
              }
              if (remove) await store.delete(entry.primaryKey);
            }
            done(undefined);
          },
          undefined,
          cleanupAdmitted,
        );
      } catch (cause) {
        if (!cleanupAdmitted()) return;
        throw cause;
      }
      if (!cleanupAdmitted()) return;
      if (forgetting.kind === 'everything') {
        const storage = browserStorage();
        if (storage === undefined)
          throw new Error('Offline image admission storage is unavailable.');
        const keys: string[] = [];
        for (let index = 0; index < storage.length; index += 1) {
          const storedKey = storage.key(index);
          if (!storedKey?.startsWith(REFUSAL_PREFIX)) continue;
          if (expectedSubject === undefined) keys.push(storedKey);
          else {
            try {
              const identity = z
                .tuple([z.string(), z.string()])
                .safeParse(JSON.parse(storedKey.slice(REFUSAL_PREFIX.length)));
              if (identity.success && identity.data[0] === expectedSubject) keys.push(storedKey);
            } catch {
              // An unrecognized marker cannot be attributed to the account being cleared.
            }
          }
        }
        for (const storedKey of keys) storage.removeItem(storedKey);
        if (expectedSubject === undefined) {
          sealedFiles.clear();
          failedSubjects.clear();
          if (admissionError === undefined) admissionFailed = false;
        } else {
          for (const identity of sealedFiles) {
            const parsed = z.tuple([z.string(), z.string()]).safeParse(JSON.parse(identity));
            if (parsed.success && parsed.data[0] === expectedSubject) sealedFiles.delete(identity);
          }
          if (admissionError === undefined) failedSubjects.delete(expectedSubject);
        }
      }
      if (admissionError !== undefined) throw admissionError;
    });
  void cleanup.catch((cause: unknown) => {
    console.warn('Offline image cleanup failed.', cause);
  });
}
onBodyForgetting(forget);
export async function clearOfflineNoteAssets(
  expectedSubject?: string,
  expectedEpoch?: string | null,
): Promise<void> {
  forget(
    expectedSubject === undefined
      ? { kind: 'everything' }
      : {
          kind: 'everything',
          subject: expectedSubject,
          epoch:
            expectedEpoch === undefined ? bodyCacheAccountEpoch(expectedSubject) : expectedEpoch,
        },
  );
  await cleanup;
}
const assetContext = createContext<{
  readonly scope: string | undefined;
  readonly offline: boolean;
  readonly generation: number;
}>({ scope: undefined, offline: false, generation: 0 });
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  if (channel === undefined && typeof BroadcastChannel !== 'undefined') {
    try {
      channel = new BroadcastChannel('nix-offline-note-assets');
      channel.addEventListener('message', (event: MessageEvent<unknown>) => {
        receive(event.data);
      });
    } catch {
      // Durable storage events remain available when broadcast channels are blocked.
    }
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      channel?.close();
      channel = undefined;
    }
  };
};
export function OfflineNoteAssetsProvider({
  scope,
  offline = false,
  children,
}: {
  readonly scope?: string | undefined;
  readonly offline?: boolean;
  readonly children: ReactNode;
}): ReactNode {
  const current = useSyncExternalStore(
    subscribe,
    () => generation,
    () => 0,
  );
  return createElement(
    assetContext.Provider,
    { value: { scope, offline, generation: current } },
    children,
  );
}
export function useOfflineNoteAssets(): {
  readonly scope: string | undefined;
  readonly offline: boolean;
  readonly generation: number;
} {
  return useContext(assetContext);
}
