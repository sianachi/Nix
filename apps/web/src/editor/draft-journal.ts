import { noteTransaction, type NoteTable } from '../lib/note-database';
import * as Y from 'yjs';
import { z } from 'zod';
import {
  bodyCacheAdmits,
  bodyCacheAccountAdmits,
  bodyCacheAccountEpoch,
  bodyCacheCleanupCurrent,
  bodyCacheDraftCurrent,
  bodyCacheDraftEpoch,
  bodyCacheScopeCurrent,
  readBodyCache,
  discardBodyCache,
} from './body-cache';
const DB = 'nix-pending-drafts';
const STORE = 'updates';
const MIGRATIONS = 'migrations';
const MAX_BYTES = 8 * 1024 * 1024;
const recordSchema = z.object({
  id: z.string(),
  scope: z.string(),
  revision: z.number().int().nonnegative(),
  docId: z.string().min(1).optional(),
  update: z.custom<Uint8Array>(
    (value) => Object.prototype.toString.call(value) === '[object Uint8Array]',
  ),
});
export type DraftRecord = z.infer<typeof recordSchema>;
export type DraftState = 'saving' | 'local' | 'synced' | 'error';
let generation = 0;
const subjectGenerations = new Map<string, number>();
let channel: BroadcastChannel | undefined;
const scopeSchema = z.tuple([z.string(), z.string(), z.string(), z.string()]);
const migrationSchema = z.object({ fromScope: z.string(), toScope: z.string(), docId: z.string() });
const lifecycleMessageSchema = z.object({
  type: z.literal('signed-out'),
  subject: z.string().optional(),
  epoch: z.string().nullable().optional(),
});
function draftGeneration(scope: string): string {
  try {
    const subject = scopeSchema.parse(JSON.parse(scope))[0];
    return JSON.stringify([
      generation,
      subjectGenerations.get(subject) ?? 0,
      bodyCacheDraftEpoch(subject),
    ]);
  } catch {
    return String(generation);
  }
}
function closeDraftGeneration(subject?: string): void {
  if (subject === undefined) generation += 1;
  else subjectGenerations.set(subject, (subjectGenerations.get(subject) ?? 0) + 1);
}
/** Owner updates may finish persisting after access refusal, for recovery without body replay. */
function admitsDraftWrite(scope: string): boolean {
  try {
    const parts = scopeSchema.parse(JSON.parse(scope));
    return bodyCacheAccountAdmits(parts[0]);
  } catch {
    return false;
  }
}
function open(): void {
  if (!channel && typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel('nix-draft-lifecycle');
    channel.onmessage = (event) => {
      const parsed = lifecycleMessageSchema.safeParse(event.data);
      if (!parsed.success) return;
      const detail = parsed.data;
      if (
        detail.subject !== undefined &&
        !bodyCacheCleanupCurrent(detail.subject, detail.epoch ?? null)
      )
        return;
      closeDraftGeneration(detail.subject);
      window.dispatchEvent(new CustomEvent('nix:signed-out-elsewhere', { detail }));
    };
  }
}
async function transaction<T>(
  mode: IDBTransactionMode,
  run: (store: NoteTable, done: (value: T) => void, migrations: NoteTable) => Promise<void>,
  admitted: () => boolean = () => true,
): Promise<T> {
  open();
  return noteTransaction(DB, [STORE, MIGRATIONS], mode, admitted, async (tx) => {
    let completion: { value: T } | undefined;
    await run(
      tx.table(STORE),
      (value) => {
        completion = { value };
      },
      tx.table(MIGRATIONS),
    );
    if (completion === undefined) throw new Error('Draft storage returned no result.');
    return completion.value;
  });
}
export async function readDrafts(scope: string): Promise<DraftRecord[]> {
  return transaction('readonly', async (store, done) => {
    const request = await store.index('scope').getAll(scope);
    const records = z.array(recordSchema).safeParse(request);
    if (!records.success || records.data.some((record) => record.update.byteLength > MAX_BYTES)) {
      throw new Error('Draft write aborted.');
    }
    done(records.data);
  });
}
export async function writeDraft(record: DraftRecord): Promise<void> {
  if (record.update.byteLength > MAX_BYTES)
    throw new Error('The draft exceeds local storage limits.');
  const subject = scopeSchema.parse(JSON.parse(record.scope))[0];
  const epoch = bodyCacheDraftEpoch(subject);
  await transaction<undefined>(
    'readwrite',
    async (store, done, migrations) => {
      const request = await migrations.get(record.scope);
      const migration = migrationSchema.safeParse(request);
      if (migration.success && !admitsDraftWrite(migration.data.toScope)) {
        throw new Error('Draft write aborted.');
      }
      await store.put(
        migration.success
          ? { ...record, scope: migration.data.toScope, docId: migration.data.docId }
          : record,
      );
      done(undefined);
    },
    () => bodyCacheDraftCurrent(subject, epoch) && admitsDraftWrite(record.scope),
  );
  draftsChanged();
}
/** Compare revisions so acknowledgement never deletes a newer edit from another tab. */
export async function acknowledgeDrafts(
  records: readonly DraftRecord[],
  admitted: () => boolean = () => true,
): Promise<void> {
  await transaction<undefined>(
    'readwrite',
    async (store, done) => {
      for (const record of records) {
        const request = await store.get(record.id);
        const current = recordSchema.safeParse(request);
        if (current.success && current.data.revision === record.revision)
          await store.delete(record.id);
      }
      done(undefined);
    },
    () => admitted() && records.every((record) => bodyCacheAdmits(record.scope)),
  );
  draftsChanged();
}
async function bindDrafts(
  scope: string,
  docId: string,
  admitted: () => boolean = () => true,
): Promise<void> {
  const parts = scopeSchema.parse(JSON.parse(scope));
  await transaction<undefined>(
    'readwrite',
    async (store, done, migrations) => {
      for (const current of await store.index('scope').entries(scope)) {
        const record = recordSchema.safeParse(current.value);
        if (
          !record.success ||
          (record.data.docId !== undefined &&
            record.data.docId !== docId &&
            record.data.docId !== `local:${parts[2]}`)
        ) {
          throw new Error('Draft write aborted.');
        }
        await store.put({ ...record.data, docId });
      }
      done(undefined);
      for (const current of await migrations.index('toScope').entries(scope)) {
        const migration = migrationSchema.safeParse(current.value);
        if (migration.success) await migrations.put({ ...migration.data, docId });
      }
    },
    () => admitted() && bodyCacheAdmits(scope),
  );
}
export async function clearDrafts(
  expectedSubject?: string,
  expectedEpoch?: string | null,
): Promise<void> {
  const epoch =
    expectedSubject === undefined
      ? undefined
      : expectedEpoch === undefined
        ? bodyCacheAccountEpoch(expectedSubject)
        : expectedEpoch;
  if (expectedSubject !== undefined && !bodyCacheCleanupCurrent(expectedSubject, epoch ?? null))
    throw new Error('Local draft cleanup was superseded by another session.');
  closeDraftGeneration(expectedSubject);
  open();
  channel?.postMessage({ type: 'signed-out', subject: expectedSubject, epoch });
  await transaction<undefined>(
    'readwrite',
    async (store, done, migrations) => {
      if (expectedSubject === undefined) {
        await store.clear();
        await migrations.clear();
      } else {
        const prefix = `${JSON.stringify([expectedSubject]).slice(0, -1)},`;
        const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
        for (const current of await store.index('scope').entries(range, undefined, true)) {
          await store.delete(current.primaryKey);
        }
        await migrations.delete(range);
        for (const current of await migrations.index('toScope').entries(range, undefined, true)) {
          await migrations.delete(current.primaryKey);
        }
      }
      done(undefined);
    },
    () => expectedSubject === undefined || bodyCacheCleanupCurrent(expectedSubject, epoch ?? null),
  );
  draftsChanged();
}
function draftsChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('nix:offline-drafts-changed'));
}
/** Pending note scopes for the currently open account, without loading their Yjs bytes. */
export async function listDraftScopes(subject: string): Promise<string[]> {
  if (!bodyCacheAccountAdmits(subject)) return [];
  const epoch = bodyCacheDraftEpoch(subject);
  const prefix = `${JSON.stringify([subject]).slice(0, -1)},`;
  return transaction('readonly', async (store, done) => {
    const scopes = new Set<string>();
    for (const current of await store.index('scope').entries(undefined, undefined, true)) {
      if (
        typeof current.key === 'string' &&
        current.key.startsWith(prefix) &&
        bodyCacheDraftCurrent(subject, epoch)
      )
        scopes.add(current.key);
    }
    done(bodyCacheDraftCurrent(subject, epoch) ? [...scopes] : []);
  });
}
/** Only a created local note starts from an empty base; every owned struct must be present. */
function completeLocalUpdate(
  records: readonly DraftRecord[],
  docId: string,
  base?: Uint8Array,
): Uint8Array {
  if (records.some((record) => record.docId !== docId))
    throw new Error('The local note cannot be recovered without its original document identity.');
  const update = Y.mergeUpdates([
    ...(base === undefined ? [] : [base]),
    ...records.map((record) => record.update),
  ]);
  const decoded = Y.decodeUpdate(update);
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, update);
    const vector = Y.decodeStateVector(Y.encodeStateVector(doc));
    if (
      decoded.structs.some((struct) => struct instanceof Y.Skip) ||
      [...Y.parseUpdateMeta(update).to].some(([client, clock]) => vector.get(client) !== clock) ||
      [...decoded.ds.clients].some(([client, deletions]) =>
        deletions.some((deletion) => deletion.clock + deletion.len > (vector.get(client) ?? 0)),
      )
    )
      throw new Error("The local note's pending updates require a missing document base.");
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}
/** Called only after an idempotent create published a local note as a new server item. */
export async function migrateLocalDrafts(
  fromScope: string,
  toScope: string,
  receipt?: {
    readonly createdItemId: string;
  },
): Promise<void> {
  const from = scopeSchema.parse(JSON.parse(fromScope));
  const to = scopeSchema.parse(JSON.parse(toScope));
  if (from[0] !== to[0] || from[1] !== to[1] || from[3] !== to[3] || fromScope === toScope)
    throw new Error('A local note can only be published within its account and workspace.');
  const epoch = bodyCacheAccountEpoch(from[0]);
  const current = (): boolean =>
    bodyCacheScopeCurrent(fromScope, epoch) && bodyCacheScopeCurrent(toScope, epoch);
  const assertCurrent = (): void => {
    if (!current()) throw new Error('Local note publication was superseded by another session.');
  };
  assertCurrent();
  const source = await readBodyCache(fromScope);
  const destination = await readBodyCache(toScope);
  const publishedId = `${toScope}:published-local`;
  const migration = await transaction<z.infer<typeof migrationSchema> | null>(
    'readonly',
    async (_store, done, migrations) => {
      const request = await migrations.get(fromScope);
      const parsed = migrationSchema.safeParse(request);
      done(parsed.success ? parsed.data : null);
    },
    current,
  );
  assertCurrent();
  if (migration?.toScope === toScope) {
    await discardBodyCache(fromScope, epoch);
    return;
  }
  let sourceUpdate = source?.update;
  let recoveredWithoutBase = false;
  if (source === null) {
    const sourceDrafts = await readDrafts(fromScope);
    const targetDrafts = await readDrafts(toScope);
    const migrated = targetDrafts.some((record) => record.id === publishedId);
    assertCurrent();
    if (
      receipt?.createdItemId !== to[2] &&
      sourceDrafts.length === 0 &&
      (migrated || destination !== null)
    )
      return;
    if (receipt?.createdItemId === to[2]) {
      sourceUpdate = completeLocalUpdate(sourceDrafts, `local:${from[2]}`);
      recoveredWithoutBase = true;
    }
  }
  if (
    (source !== null && source.docId !== `local:${from[2]}`) ||
    sourceUpdate === undefined ||
    (destination !== null && receipt?.createdItemId !== to[2])
  )
    throw new Error('The local note cannot be merged into an existing server document.');
  const completeSourceUpdate = sourceUpdate;
  const placeholderDocId = `local:${to[2]}`;
  await transaction<undefined>(
    'readwrite',
    async (store, done, migrations) => {
      const mapping = await migrations.get(fromScope);
      const known = migrationSchema.safeParse(mapping);
      if (known.success) {
        if (known.data.toScope !== toScope) throw new Error('Draft write aborted.');
        else done(undefined);
        return;
      }
      const request = await store.index('scope').getAll(fromScope);
      const parsed = z.array(recordSchema).safeParse(request);
      if (!parsed.success) {
        throw new Error('Draft write aborted.');
      }
      const records = parsed.data;
      if (
        records.some((record) => record.docId !== undefined && record.docId !== `local:${from[2]}`)
      ) {
        throw new Error('Draft write aborted.');
      }
      let localUpdate: Uint8Array;
      try {
        localUpdate = recoveredWithoutBase
          ? completeLocalUpdate(records, `local:${from[2]}`, completeSourceUpdate)
          : Y.mergeUpdates([completeSourceUpdate, ...records.map((record) => record.update)]);
      } catch {
        throw new Error('Draft write aborted.');
      }
      const existing = await store.get(publishedId);
      const previous = recordSchema.safeParse(existing);
      if (
        existing !== undefined &&
        (!previous.success || previous.data.scope !== toScope || previous.data.docId === undefined)
      ) {
        throw new Error('Draft write aborted.');
      }
      const previousDocId = previous.success ? previous.data.docId : undefined;
      if (
        destination !== null &&
        previousDocId !== undefined &&
        previousDocId !== placeholderDocId &&
        previousDocId !== destination.docId
      ) {
        throw new Error('Draft write aborted.');
      }
      const destinationDocId = destination?.docId ?? previousDocId ?? placeholderDocId;
      let update: Uint8Array;
      try {
        update = Y.mergeUpdates([
          localUpdate,
          ...(destination === null ? [] : [destination.update]),
          ...(previous.success ? [previous.data.update] : []),
        ]);
      } catch {
        throw new Error('Draft write aborted.');
      }
      if (update.byteLength > MAX_BYTES) {
        throw new Error('Draft write aborted.');
      }
      if (!current()) {
        throw new Error('Draft write aborted.');
      }
      await store.put({
        id: publishedId,
        scope: toScope,
        revision: previous.success ? previous.data.revision + 1 : 0,
        docId: destinationDocId,
        update,
      } satisfies DraftRecord);
      for (const record of records) await store.delete(record.id);
      await migrations.put({ fromScope, toScope, docId: destinationDocId });
      done(undefined);
    },
    current,
  );
  await discardBodyCache(fromScope, epoch);
  draftsChanged();
}
export interface DraftJournalStore {
  read: (scope: string) => Promise<DraftRecord[]>;
  write: (record: DraftRecord) => Promise<void>;
  acknowledge: (records: readonly DraftRecord[], admitted?: () => boolean) => Promise<void>;
  bind?: (scope: string, docId: string, admitted?: () => boolean) => Promise<void>;
}
export interface DraftJournal {
  read: () => Promise<DraftRecord[]>;
  append: (update: Uint8Array) => void;
  snapshot: () => Promise<DraftRecord[]>;
  acknowledge: (records: readonly DraftRecord[], admitted?: () => boolean) => Promise<void>;
  discard: () => Promise<void>;
  bindDocument: (docId: string, admitted?: () => boolean) => Promise<void>;
}
export function createDraftJournal(
  scope: string,
  onState: (state: DraftState) => void,
  store: DraftJournalStore = {
    read: readDrafts,
    write: writeDraft,
    acknowledge: acknowledgeDrafts,
    bind: bindDrafts,
  },
): DraftJournal {
  const id = `${scope}:${crypto.randomUUID()}`;
  const epoch = draftGeneration(scope);
  let restored: DraftRecord[] = [];
  let revision = 0;
  let merged: Uint8Array | null = null;
  let chain = Promise.resolve();
  let disabled = false;
  let docId: string | undefined;
  let failure: Error | null = null;
  return {
    async read(): Promise<DraftRecord[]> {
      restored = await store.read(scope);
      if (restored.length) onState('local');
      return restored;
    },
    append(update: Uint8Array): void {
      if (disabled || epoch !== draftGeneration(scope)) {
        onState('error');
        return;
      }
      if ((merged?.byteLength ?? 0) + update.byteLength > MAX_BYTES) {
        disabled = true;
        failure = new Error('The draft exceeds local storage limits.');
        onState('error');
        return;
      }
      merged = merged === null ? update : Y.mergeUpdates([merged, update]);
      revision += 1;
      const record = { id, scope, revision, docId, update: new Uint8Array(merged) };
      onState('saving');
      chain = chain
        .then(() => {
          if (epoch !== draftGeneration(scope))
            throw new Error('This account’s local draft storage is closed.');
          return store.write(record);
        })
        .then(() => {
          if (record.revision === revision) {
            failure = null;
            onState('local');
          }
        })
        .catch((cause: unknown) => {
          failure =
            cause instanceof Error ? cause : new Error('The local draft could not be saved.');
          onState('error');
        });
    },
    async snapshot(): Promise<DraftRecord[]> {
      await chain;
      if (failure !== null) throw failure;
      return [...restored, ...(await store.read(scope)).filter((record) => record.id === id)];
    },
    async acknowledge(records: readonly DraftRecord[], admitted?: () => boolean): Promise<void> {
      if (admitted?.() === false) throw new Error('This draft’s offline storage is closed.');
      await store.acknowledge(records, admitted);
      if (admitted?.() === false) throw new Error('This draft’s offline storage is closed.');
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
    async bindDocument(identity: string, admitted?: () => boolean): Promise<void> {
      docId = identity;
      await chain;
      if (failure !== null) throw failure;
      if (admitted?.() === false) throw new Error('This draft’s offline storage is closed.');
      const records = await store.read(scope);
      if (admitted?.() === false) throw new Error('This draft’s offline storage is closed.');
      if (store.bind !== undefined) await store.bind(scope, identity, admitted);
      else
        for (const record of records) {
          if (admitted?.() === false) throw new Error('This draft’s offline storage is closed.');
          await store.write({ ...record, docId: identity });
        }
      if (admitted?.() === false) throw new Error('This draft’s offline storage is closed.');
      restored = restored.map((record) => ({ ...record, docId: identity }));
    },
  };
}
