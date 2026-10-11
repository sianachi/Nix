import { defineBinaryQuery, defineCommand, NixApiError, type NixClient } from '@nix/api-client';
import { SCHEMA_VERSION } from '@nix/editor-schema';
import * as Y from 'yjs';
import { z } from 'zod';

import {
  bodyCacheAdmits,
  bodyCacheAccountEpoch,
  bodyCacheFenceVersion,
  documentScope,
  readBodyCache,
  sealBodyCache,
  writeBodyCache,
} from '../editor/body-cache';
import { flushLocalDraftsForScope } from '../editor/collab-sync';
import { createDraftJournal, type DraftRecord } from '../editor/draft-journal';
import { readOfflineAccount } from './offline-store';

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_PAGE_BYTES = 32 * 1024 * 1024;
const MAX_UPDATE_BYTES = 1024 * 1024;
const sequence = z
  .string()
  .regex(/^\d+$/u)
  .max(20)
  .transform((value) => BigInt(value));
const encodedUpdate = z
  .string()
  .min(1)
  .max(Math.ceil((16 * 1024 * 1024) / 3) * 4);
const entrySchema = z.object({ seq: sequence, update: encodedUpdate });
const pageSchema = z.object({
  docId: z.string().min(1).max(128),
  headSeq: sequence,
  schemaVersion: z.number().int().nonnegative(),
  canWrite: z.boolean(),
  checkpoint: entrySchema.optional(),
  updates: z.array(entrySchema).max(500),
  hasMore: z.boolean(),
});
const receiptSchema = z.object({ docId: z.string().min(1), seq: sequence });

export interface OfflineBodyOptions {
  readonly client: NixClient;
  readonly subject: string;
  readonly workspaceId: string;
  readonly itemId: string;
  readonly doc: Y.Doc;
  readonly signal: AbortSignal;
  readonly onReadOnly?: (() => Promise<void>) | undefined;
}

interface AdmittedBodyOptions extends OfflineBodyOptions {
  readonly accountEpoch: string | null;
  readonly itemFence: string | null;
}

function admits(options: AdmittedBodyOptions, scope: string): boolean {
  return (
    !options.signal.aborted &&
    readOfflineAccount()?.subject === options.subject &&
    bodyCacheAdmits(scope) &&
    bodyCacheAccountEpoch(options.subject) === options.accountEpoch &&
    bodyCacheFenceVersion(scope) === options.itemFence
  );
}

function assertAdmitted(options: AdmittedBodyOptions, scope: string): void {
  options.signal.throwIfAborted();
  if (!admits(options, scope)) throw new Error('This note’s offline storage is closed.');
}

function decode(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value))
    throw new Error('Nix returned an invalid document update.');
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function encode(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

class CheckpointGap extends Error {}

async function rejectReplacement(
  options: AdmittedBodyOptions,
  scope: string,
  message: string,
): Promise<never> {
  assertAdmitted(options, scope);
  await sealBodyCache(scope, 'refused');
  throw new Error(message);
}

async function retainBody(
  options: AdmittedBodyOptions,
  scope: string,
  docId: string,
  update: Uint8Array,
): Promise<Uint8Array> {
  if (update.byteLength > MAX_BODY_BYTES)
    throw new Error('This note exceeds the 8 MiB offline storage limit.');
  assertAdmitted(options, scope);
  const savedAt = Date.now();
  await writeBodyCache({ scope, docId, schemaVersion: SCHEMA_VERSION, savedAt, update }, () =>
    admits(options, scope),
  );
  assertAdmitted(options, scope);
  const saved = await readBodyCache(scope);
  assertAdmitted(options, scope);
  if (saved?.docId !== docId || saved.savedAt < savedAt)
    throw new Error('This note could not be retained on this device.');
  return update;
}

async function downloadBody(
  options: AdmittedBodyOptions,
  scope: string,
): Promise<{
  doc: Y.Doc;
  docId: string;
  schemaVersion: number;
  canWrite: boolean;
}> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const doc = new Y.Doc();
    let after = 0n;
    let identity: z.infer<typeof pageSchema> | undefined;
    try {
      for (let pageNumber = 0; pageNumber < 2048; pageNumber += 1) {
        assertAdmitted(options, scope);
        const result = await options.client.download(
          defineBinaryQuery({
            operation: 'offline.body.read',
            path: `/collab/documents/${z.uuid().parse(options.itemId)}/updates`,
            query: { after: String(after), fromCheckpoint: after === 0n ? 'true' : undefined },
          }),
          { signal: options.signal, maxResponseBytes: MAX_PAGE_BYTES },
        );
        assertAdmitted(options, scope);
        const page = pageSchema.parse(JSON.parse(await result.blob.text()));
        assertAdmitted(options, scope);
        if (page.schemaVersion > SCHEMA_VERSION)
          throw new Error('This note requires a newer editor before it can be downloaded.');
        if (
          identity !== undefined &&
          (identity.docId !== page.docId || identity.schemaVersion !== page.schemaVersion)
        )
          await rejectReplacement(
            options,
            scope,
            'The note body changed during its download. Its pending edits were preserved.',
          );
        identity = page;
        const previous = after;
        if (after === 0n && page.checkpoint !== undefined) {
          if (page.checkpoint.seq > page.headSeq)
            throw new Error('Nix returned a checkpoint beyond this note’s recorded state.');
          Y.applyUpdate(doc, decode(page.checkpoint.update));
          after = page.checkpoint.seq;
        }
        for (const entry of page.updates) {
          if (entry.seq <= after) continue;
          if (entry.seq !== after + 1n)
            throw new CheckpointGap('The note needs a newer retained checkpoint.');
          Y.applyUpdate(doc, decode(entry.update));
          after = entry.seq;
        }
        if (!page.hasMore || page.updates.length === 0) {
          if (after < page.headSeq)
            throw new CheckpointGap('The note needs a newer retained checkpoint.');
          return {
            doc,
            docId: page.docId,
            schemaVersion: page.schemaVersion,
            canWrite: page.canWrite,
          };
        }
        if (after <= previous) throw new CheckpointGap('The note body download did not advance.');
      }
      throw new Error('This note’s update history exceeded the download limit.');
    } catch (cause) {
      doc.destroy();
      if (!(cause instanceof CheckpointGap) || attempt === 2) throw cause;
    }
  }
  throw new Error('The note body could not be downloaded.');
}

/** Downloads and confirms bodies without consuming a resident collaboration session. */
export async function synchronizeOfflineBody(
  input: OfflineBodyOptions,
): Promise<{ docId: string; canWrite: boolean }> {
  const scope = documentScope(input.subject, input.workspaceId, input.itemId, 'note');
  if (scope === undefined) throw new Error('The offline note has no account scope.');
  const options: AdmittedBodyOptions = {
    ...input,
    accountEpoch: bodyCacheAccountEpoch(input.subject),
    itemFence: bodyCacheFenceVersion(scope),
  };
  assertAdmitted(options, scope);
  await flushLocalDraftsForScope(scope);
  assertAdmitted(options, scope);
  const cached = await readBodyCache(scope);
  assertAdmitted(options, scope);
  const journal = createDraftJournal(scope, () => undefined);
  const records = await journal.read();
  assertAdmitted(options, scope);
  const remote = await downloadBody(options, scope);
  try {
    if (!remote.canWrite) await options.onReadOnly?.();
    assertAdmitted(options, scope);
    const localIdentity = `local:${options.itemId}`;
    const receipt = records.some(
      (record) => record.id === `${scope}:published-local` && record.docId === localIdentity,
    );
    const admitsIdentity = (docId: string | undefined): boolean =>
      docId === remote.docId || (receipt && docId === localIdentity);
    if (
      (cached !== null && !admitsIdentity(cached.docId)) ||
      records.some((record) =>
        record.docId === undefined ? cached?.docId !== remote.docId : !admitsIdentity(record.docId),
      )
    ) {
      await rejectReplacement(
        options,
        scope,
        'A local draft belongs to another document. Its pending edits were preserved.',
      );
    }
    assertAdmitted(options, scope);
    const serverUpdate = Y.encodeStateAsUpdate(remote.doc);
    const serverVector = Y.encodeStateVector(remote.doc);
    if (cached !== null && cached.schemaVersion === SCHEMA_VERSION)
      Y.applyUpdate(remote.doc, cached.update);
    for (const record of records) Y.applyUpdate(remote.doc, record.update);
    await journal.bindDocument(remote.docId, () => admits(options, scope));
    assertAdmitted(options, scope);
    const acknowledged: DraftRecord[] = records.map((record) => ({
      ...record,
      docId: remote.docId,
    }));
    if (records.length > 0) {
      if (!remote.canWrite) {
        await retainBody(options, scope, remote.docId, serverUpdate);
        throw new Error('This note is read-only. Pending edits remain saved on this device.');
      }
      const update = Y.encodeStateAsUpdate(remote.doc, serverVector);
      if (update.byteLength > MAX_UPDATE_BYTES)
        throw new Error(
          'This pending edit exceeds the 1 MiB synchronization limit. Its local copy is preserved.',
        );
      // An empty difference is already durable; lost-response retries must not create duplicate text.
      const difference = Y.decodeUpdate(update);
      if (difference.structs.length > 0 || difference.ds.clients.size > 0) {
        assertAdmitted(options, scope);
        try {
          const appended = await options.client.execute(
            defineCommand({
              operation: 'offline.body.append',
              method: 'POST',
              path: `/collab/documents/${options.itemId}/updates`,
              body: {
                update: encode(update),
                clientId: `offline:${options.subject}`,
                expectedDocId: remote.docId,
              },
              schema: receiptSchema,
            }),
            { signal: options.signal },
          );
          assertAdmitted(options, scope);
          if (appended.docId !== remote.docId)
            await rejectReplacement(
              options,
              scope,
              'The note body changed before its edits were confirmed. Its pending edits were preserved.',
            );
        } catch (cause) {
          if (
            cause instanceof NixApiError &&
            cause.status === 409 &&
            cause.code === 'document_changed'
          )
            await rejectReplacement(
              options,
              scope,
              'The note body changed before its edits were confirmed. Its pending edits were preserved.',
            );
          if (
            !(cause instanceof NixApiError) ||
            cause.status !== 403 ||
            cause.code === 'auth.principal_inactive'
          )
            throw cause;
          const readable = await downloadBody(options, scope);
          try {
            await options.onReadOnly?.();
            assertAdmitted(options, scope);
            if (readable.docId !== remote.docId || readable.schemaVersion !== remote.schemaVersion)
              await rejectReplacement(
                options,
                scope,
                'The note body changed. Its pending edits were preserved.',
              );
            await retainBody(options, scope, remote.docId, Y.encodeStateAsUpdate(readable.doc));
          } finally {
            readable.doc.destroy();
          }
          throw new Error('This note is read-only. Pending edits remain saved on this device.');
        }
      }
      const confirmed = await downloadBody(options, scope);
      const canWrite = confirmed.canWrite;
      try {
        if (!canWrite) await options.onReadOnly?.();
        assertAdmitted(options, scope);
        if (confirmed.docId !== remote.docId || confirmed.schemaVersion !== remote.schemaVersion)
          await rejectReplacement(
            options,
            scope,
            'The note body changed before its edits were retained. Its pending edits were preserved.',
          );
        if (!canWrite) {
          await retainBody(options, scope, remote.docId, Y.encodeStateAsUpdate(confirmed.doc));
          throw new Error('This note is read-only. Pending edits remain saved on this device.');
        }
        Y.applyUpdate(remote.doc, Y.encodeStateAsUpdate(confirmed.doc));
      } finally {
        confirmed.doc.destroy();
      }
    }
    const update = await retainBody(
      options,
      scope,
      remote.docId,
      Y.encodeStateAsUpdate(remote.doc),
    );
    await journal.acknowledge(acknowledged, () => admits(options, scope));
    assertAdmitted(options, scope);
    Y.applyUpdate(options.doc, update);
    return { docId: remote.docId, canWrite: remote.canWrite };
  } finally {
    remote.doc.destroy();
  }
}
