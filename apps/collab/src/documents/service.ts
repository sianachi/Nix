import { SCHEMA_VERSION, countNodes, nixSchema } from '@nix/editor-schema';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import * as Y from 'yjs';

import {
  appendUpdate,
  createDoc,
  findDocByItem,
  snapshotAtOrBefore,
  updatesAfter,
  writeSnapshot,
  type ContentDocRow,
} from '../db/documents.ts';
import type { ScopedQuery } from '../db/tenant-scope.ts';
import { LIMITS, type Rejection, rejection } from './limits.ts';

/**
 * The Yjs fragment the editor binds to. One name, agreed by both sides; a mismatch would
 * produce two documents that merge cleanly and share no text.
 */
export const FRAGMENT_NAME = 'default';

/** How many updates one catch-up returns. A client that is further behind asks again. */
export const CATCH_UP_LIMIT = 500;

export interface AppendResult {
  readonly seq: bigint;
  readonly snapshotWritten: boolean;
}

export type Appended = { ok: true; value: AppendResult } | { ok: false; error: Rejection };

/**
 * Loads a document's state by replaying its log from the newest snapshot.
 *
 * **A snapshot is an optimisation and never a source of truth.** Deleting every snapshot in
 * the database costs replay time and loses nothing, which is the property that lets the
 * snapshot cadence change - or a bad snapshot be discarded - without a migration.
 */
export async function loadDocument(
  sql: ScopedQuery,
  tenantId: string,
  doc: ContentDocRow,
): Promise<Y.Doc> {
  const head = BigInt(doc.head_seq);
  const state = new Y.Doc();

  const snapshot = await snapshotAtOrBefore(sql, tenantId, doc.doc_id, head);
  let from = 0n;

  if (snapshot !== null) {
    Y.applyUpdate(state, new Uint8Array(snapshot.yjs_state));
    from = BigInt(snapshot.seq);
  }

  // Replayed in pages rather than in one query, so a document with a long log since its
  // last snapshot cannot be the thing that decides this process's memory ceiling.
  for (;;) {
    const page = await updatesAfter(sql, tenantId, doc.doc_id, from, CATCH_UP_LIMIT);
    if (page.length === 0) {
      break;
    }

    Y.transact(state, () => {
      for (const row of page) {
        Y.applyUpdate(state, new Uint8Array(row.update_bytes));
      }
    });

    const last = page[page.length - 1];
    if (last === undefined) {
      break;
    }

    from = BigInt(last.seq);
  }

  return state;
}

/**
 * Finds an item's document body, creating it on first use.
 *
 * Returns null when the item is not visible to this tenant - which the caller has already
 * established it is, through Core, so this is the belt to that braces.
 */
export async function openDocument(
  sql: ScopedQuery,
  tenantId: string,
  itemId: string,
  workspaceId: string,
  newDocId: () => string,
): Promise<ContentDocRow | null> {
  const existing = await findDocByItem(sql, tenantId, itemId);
  if (existing !== null) {
    return existing;
  }

  await createDoc(sql, {
    docId: newDocId(),
    tenantId,
    itemId,
    workspaceId,
    schemaVersion: SCHEMA_VERSION,
  });

  // Re-read rather than trusting the identifier just minted: the insert may have done
  // nothing because another request created the document first, and that request's
  // identifier is the one everybody else will use.
  return await findDocByItem(sql, tenantId, itemId);
}

/**
 * Applies an update, checks what it produced, and stores it if the result is a document.
 *
 * **Validation happens by applying, not by inspecting.** A Yjs update is a set of
 * operations, not a document, so the only honest question is what the document becomes once
 * they are merged - and that question is asked against a throwaway copy, so a rejected
 * update leaves nothing behind.
 *
 * The checks, in the order that makes the cheapest refusal first:
 *
 * 1. the payload fits the update ceiling, which matches the column's own CHECK;
 * 2. it decodes as a Yjs update at all;
 * 3. the merged document still parses against `SCHEMA_VERSION`'s node and mark set;
 * 4. the merged document is under the node and byte ceilings.
 *
 * Rate backpressure is applied by the caller, before any of this, because it is the one
 * refusal that should not cost a database round trip.
 */
export async function applyUpdate(
  sql: ScopedQuery,
  input: {
    tenantId: string;
    doc: ContentDocRow;
    updateBytes: Uint8Array;
    actorId: string;
    clientId: string;
    snapshotEvery: number;
  },
): Promise<Appended> {
  if (input.updateBytes.byteLength > LIMITS.updateBytes) {
    return {
      ok: false,
      error: rejection(
        'update_too_large',
        `An update may be at most ${String(LIMITS.updateBytes)} bytes; this one is ` +
          `${String(input.updateBytes.byteLength)}.`,
      ),
    };
  }

  if (input.doc.schema_version !== SCHEMA_VERSION) {
    return {
      ok: false,
      error: rejection(
        'schema_version_mismatch',
        `This document was written against schema version ${String(input.doc.schema_version)}; ` +
          `this build speaks version ${String(SCHEMA_VERSION)}. Refusing to write rather than ` +
          'reinterpreting the document.',
      ),
    };
  }

  const state = await loadDocument(sql, input.tenantId, input.doc);

  try {
    Y.applyUpdate(state, input.updateBytes);
  } catch (cause) {
    return {
      ok: false,
      error: rejection(
        'update_unreadable',
        cause instanceof Error ? cause.message : 'The payload is not a Yjs update.',
      ),
    };
  }

  const verdict = checkMergedDocument(state);
  if (verdict !== null) {
    return { ok: false, error: verdict };
  }

  const seq = await appendUpdate(sql, {
    tenantId: input.tenantId,
    docId: input.doc.doc_id,
    updateBytes: input.updateBytes,
    actorId: input.actorId,
    clientId: input.clientId,
  });

  const snapshotWritten = await maybeSnapshot(sql, {
    tenantId: input.tenantId,
    docId: input.doc.doc_id,
    seq,
    state,
    snapshotEvery: input.snapshotEvery,
  });

  return { ok: true, value: { seq, snapshotWritten } };
}

/**
 * Whether the merged document is one this build would be able to open again.
 *
 * Returns the refusal, or null when it is fine.
 */
export function checkMergedDocument(state: Y.Doc): Rejection | null {
  const document = readDocument(state);
  if (document === null) {
    return rejection(
      'document_does_not_parse',
      'Applying this update would produce a document the schema rejects.',
    );
  }

  const nodes = countNodes(document);
  if (nodes > LIMITS.documentNodes) {
    return rejection(
      'document_too_many_nodes',
      `A document may hold at most ${String(LIMITS.documentNodes)} nodes; this one would hold ` +
        `${String(nodes)}.`,
    );
  }

  const bytes = Buffer.byteLength(JSON.stringify(document.toJSON()));
  if (bytes > LIMITS.documentBytes) {
    return rejection(
      'document_too_large',
      `A document may be at most ${String(LIMITS.documentBytes)} bytes; this one would be ` +
        `${String(bytes)}.`,
    );
  }

  return null;
}

/**
 * Measures a state as a document: how many nodes, how many serialised bytes - or null
 * when it does not parse at all.
 *
 * Exported for the socket path's growth rule: a document over a ceiling refuses inserts
 * and allows deletes, and telling the two apart means measuring the state before the
 * candidate update as well as after it.
 */
export function measureDocument(state: Y.Doc): { nodes: number; bytes: number } | null {
  const document = readDocument(state);
  if (document === null) {
    return null;
  }

  return {
    nodes: countNodes(document),
    bytes: Buffer.byteLength(JSON.stringify(document.toJSON())),
  };
}

/**
 * Reads the shared fragment as a document, or null when it is not one.
 *
 * Two failures are folded together on purpose: a fragment holding a node this build has never
 * heard of throws while being read, and a fragment whose shape breaks the content rules fails
 * `check()`. Both mean the same thing to a caller - the merge would produce something that
 * cannot be opened - and neither is worth distinguishing in a refusal.
 */
function readDocument(state: Y.Doc): ProseMirrorNode | null {
  try {
    const document = yXmlFragmentToProseMirrorRootNode(
      state.getXmlFragment(FRAGMENT_NAME),
      nixSchema,
    );
    document.check();
    return document;
  } catch {
    return null;
  }
}

/**
 * Writes a snapshot when the sequence crosses the cadence.
 *
 * The plaintext and the ProseMirror JSON are stored alongside the Yjs state because search
 * and previews need the document without a Yjs runtime - and because a materialisation that
 * only one process can read is not much of a materialisation.
 */
async function maybeSnapshot(
  sql: ScopedQuery,
  input: {
    tenantId: string;
    docId: string;
    seq: bigint;
    state: Y.Doc;
    snapshotEvery: number;
  },
): Promise<boolean> {
  if (input.snapshotEvery <= 0 || input.seq % BigInt(input.snapshotEvery) !== 0n) {
    return false;
  }

  return await writeSnapshotNow(sql, input);
}

/**
 * Materialises and writes a snapshot at a sequence, cadence already decided.
 *
 * Exported for the resident-document path, whose cadence is richer than "every N": it also
 * snapshots on a activity timer and on eviction, and those decisions live with the session
 * rather than being restated here.
 */
export async function writeSnapshotNow(
  sql: ScopedQuery,
  input: {
    tenantId: string;
    docId: string;
    seq: bigint;
    state: Y.Doc;
  },
): Promise<boolean> {
  const encoded = Y.encodeStateAsUpdate(input.state);
  if (encoded.byteLength > LIMITS.snapshotBytes) {
    // The update itself was accepted and is in the log, which is the source of truth. A
    // snapshot too large to store costs replay time and nothing else, so this is a missed
    // optimisation rather than a failure, and the request must not fail because of it.
    return false;
  }

  const document = readDocument(input.state);

  await writeSnapshot(sql, {
    tenantId: input.tenantId,
    docId: input.docId,
    seq: input.seq,
    yjsState: encoded,
    prosemirrorJson: document?.toJSON() ?? null,
    plaintext: document === null ? '' : document.textBetween(0, document.content.size, '\n', ' '),
  });

  return true;
}

/** The schema this build validates against, for the health endpoint to report. */
export function describeSchema(): { version: number; nodes: number; marks: number } {
  return {
    version: SCHEMA_VERSION,
    nodes: Object.keys(nixSchema.nodes).length,
    marks: Object.keys(nixSchema.marks).length,
  };
}
