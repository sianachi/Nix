import type { ScopedQuery } from './tenant-scope.ts';

/**
 * The content tables, as this service reads and writes them.
 *
 * Hand-written SQL rather than an ORM, for the same reason Core writes the closure by
 * hand: these run on every keystroke's worth of traffic and their plans should be legible.
 * Every statement is tenant-parameterised as well as relying on the isolation policies -
 * defence in depth, and a predicate the planner can turn into an index condition.
 */

export interface ContentDocRow extends Record<string, unknown> {
  readonly doc_id: string;
  readonly item_id: string;
  readonly workspace_id: string;
  readonly schema_version: number;
  readonly head_seq: string;
}

export interface UpdateRow extends Record<string, unknown> {
  readonly seq: string;
  readonly update_bytes: Buffer;
  readonly actor_id: string | null;
  readonly client_id: string;
  readonly created_at: Date;
}

export interface SnapshotRow extends Record<string, unknown> {
  readonly seq: string;
  readonly yjs_state: Buffer;
}

/** Finds the document body attached to an item, if one has been created. */
export async function findDocByItem(
  sql: ScopedQuery,
  tenantId: string,
  itemId: string,
): Promise<ContentDocRow | null> {
  const { rows } = await sql.query<ContentDocRow>(
    `SELECT doc_id, item_id, workspace_id, schema_version, head_seq
     FROM content_doc
     WHERE tenant_id = $1 AND item_id = $2`,
    [tenantId, itemId],
  );

  return rows[0] ?? null;
}

/**
 * Creates the document body for an item.
 *
 * Bodies are created on first edit rather than with the item, so a folder of a thousand
 * notes nobody has opened stores a thousand rows fewer. `ON CONFLICT DO NOTHING` makes two
 * clients opening the same note at the same moment produce one document rather than an
 * error for whichever lost; the conflict target is the unique `(tenant_id, item_id)` index
 * that enforces one body per item.
 */
export async function createDoc(
  sql: ScopedQuery,
  input: {
    docId: string;
    tenantId: string;
    itemId: string;
    workspaceId: string;
    schemaVersion: number;
  },
): Promise<void> {
  await sql.query(
    `INSERT INTO content_doc
         (doc_id, tenant_id, item_id, workspace_id, schema_version, head_seq, created_at)
     VALUES ($1, $2, $3, $4, $5, 0, now())
     ON CONFLICT (tenant_id, item_id) DO NOTHING`,
    [input.docId, input.tenantId, input.itemId, input.workspaceId, input.schemaVersion],
  );
}

/**
 * Reads the updates after a sequence, in order.
 *
 * A range scan of `(doc_id, seq)`, which is the primary key, so catching up costs no
 * secondary index and no sort.
 */
export async function updatesAfter(
  sql: ScopedQuery,
  tenantId: string,
  docId: string,
  afterSeq: bigint,
  limit: number,
): Promise<UpdateRow[]> {
  const { rows } = await sql.query<UpdateRow>(
    `SELECT seq, update_bytes, actor_id, client_id, created_at
     FROM content_update
     WHERE tenant_id = $1 AND doc_id = $2 AND seq > $3
     ORDER BY seq
     LIMIT $4`,
    [tenantId, docId, afterSeq.toString(), limit],
  );

  return rows;
}

/** The newest snapshot at or before a sequence, if there is one. */
export async function snapshotAtOrBefore(
  sql: ScopedQuery,
  tenantId: string,
  docId: string,
  seq: bigint,
): Promise<SnapshotRow | null> {
  const { rows } = await sql.query<SnapshotRow>(
    `SELECT seq, yjs_state
     FROM content_snapshot
     WHERE tenant_id = $1 AND doc_id = $2 AND seq <= $3
     ORDER BY seq DESC
     LIMIT 1`,
    [tenantId, docId, seq.toString()],
  );

  return rows[0] ?? null;
}

/**
 * Appends one update and advances the document's head.
 *
 * **The sequence is allocated by the database, not by the caller.** `head_seq + 1` inside
 * an `UPDATE ... RETURNING` takes a row lock, so two concurrent appends serialise and
 * cannot be handed the same number. A number chosen in the service would collide the first
 * time two people typed at once, and the log would lose one of them.
 */
export async function appendUpdate(
  sql: ScopedQuery,
  input: {
    tenantId: string;
    docId: string;
    updateBytes: Uint8Array;
    actorId: string;
    clientId: string;
  },
): Promise<bigint> {
  const { rows } = await sql.query<{ head_seq: string }>(
    `UPDATE content_doc
     SET head_seq = head_seq + 1
     WHERE tenant_id = $1 AND doc_id = $2
     RETURNING head_seq`,
    [input.tenantId, input.docId],
  );

  const head = rows[0];
  if (head === undefined) {
    throw new Error(`No content_doc ${input.docId} is visible to this tenant.`);
  }

  const seq = BigInt(head.head_seq);

  await sql.query(
    `INSERT INTO content_update
         (doc_id, seq, tenant_id, update_bytes, actor_id, client_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())`,
    [
      input.docId,
      seq.toString(),
      input.tenantId,
      Buffer.from(input.updateBytes),
      input.actorId,
      input.clientId,
    ],
  );

  return seq;
}

/**
 * Writes a snapshot.
 *
 * A materialisation of the log up to a sequence, never a source of truth: deleting every
 * snapshot loses nothing but the time it takes to replay. `ON CONFLICT DO NOTHING` because
 * two replicas crossing the same threshold would otherwise race to write identical rows.
 */
export async function writeSnapshot(
  sql: ScopedQuery,
  input: {
    tenantId: string;
    docId: string;
    seq: bigint;
    yjsState: Uint8Array;
    prosemirrorJson: unknown;
    plaintext: string;
  },
): Promise<void> {
  await sql.query(
    `INSERT INTO content_snapshot
         (doc_id, seq, tenant_id, yjs_state, prosemirror_json, plaintext, created_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, now())
     ON CONFLICT (doc_id, seq) DO NOTHING`,
    [
      input.docId,
      input.seq.toString(),
      input.tenantId,
      Buffer.from(input.yjsState),
      JSON.stringify(input.prosemirrorJson),
      input.plaintext,
    ],
  );
}
