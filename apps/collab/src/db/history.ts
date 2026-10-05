import * as Y from 'yjs';

import { snapshotAtOrBefore, writeSnapshot, type UpdateRow } from './documents.ts';
import type { ScopedQuery } from './tenant-scope.ts';

/**
 * A run of consecutive updates by one actor, coalesced from the log.
 *
 * Derived, never stored - a revision is a way of reading `content_update`, not a row of its
 * own. Identified by the last sequence in the run, which is also the sequence a caller names
 * or restores to: "the state after this revision" is unambiguous, where "the state during it"
 * is not.
 */
export interface Revision {
  readonly seq: number;
  readonly fromSeq: number;
  readonly actorId: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly updateCount: number;
  readonly name: string | null;
}

/** A revision somebody named. Mirrors `content_version`. */
export interface NamedVersion {
  readonly seq: number;
  readonly name: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

/**
 * How long a gap between two updates from the same actor may be before it starts a new
 * revision. Ten minutes is long enough that a paragraph's worth of pauses (reading back what
 * was just written, switching tabs) stays one revision, and short enough that a lunch break
 * reliably starts a new one.
 */
export const REVISION_GAP_MS = 10 * 60 * 1000;

/** How many raw update rows one page of `stateAt`'s replay reads at a time. */
const REPLAY_PAGE = 500;

/**
 * The size of the first window `listRevisions` reads, in raw update rows, and how much it
 * grows by each time that window turns out not to hold enough complete revisions.
 *
 * A revision is usually many updates - a paragraph is dozens of keystroke-sized ops - so
 * reading a handful of update rows at a time would mean growing the window on almost every
 * call. Reading too many wastes nothing but the query: the window is bounded by `WINDOW_CAP`
 * regardless.
 */
const WINDOW_INITIAL = 200;
const WINDOW_CAP = 20_000;

/**
 * Groups a document's update log into revisions.
 *
 * **Pure, and the reason it can be.** Everything a revision needs - who wrote it, when, how
 * many updates - is already on each row; this only decides where one run ends and the next
 * begins. `rows` must be in ascending `seq` order, which is the order every reader of the log
 * already produces it in.
 *
 * A revision ends, and the next begins, when the actor changes or when the gap since the
 * previous update exceeds `gapMs`. Every row belongs to exactly one revision, so a caller that
 * hands this the whole log gets the whole history back, not just what happened to fall inside
 * some window.
 *
 * `name` is always null here: naming is a fact about `content_version`, which this function
 * never sees. {@link attachNames} is the pure counterpart that adds it back once a caller has
 * looked names up.
 */
export function coalesceRevisions(
  rows: readonly UpdateRow[],
  gapMs: number = REVISION_GAP_MS,
): readonly Revision[] {
  const revisions: Revision[] = [];

  let run: {
    fromSeq: bigint;
    seq: bigint;
    actorId: string;
    startedAt: Date;
    endedAt: Date;
    updateCount: number;
  } | null = null;

  for (const row of rows) {
    // actor_id is NOT NULL at the database level; the empty-string fallback is only for the
    // defensive `| null` this row type carries, and never groups two different missing
    // actors as if they were the same one by accident - it groups them as the same actor
    // "unknown", which is the closest thing to true here.
    const actorId = row.actor_id ?? '';
    const seq = BigInt(row.seq);
    const createdAt = row.created_at;

    if (
      run !== null &&
      run.actorId === actorId &&
      createdAt.getTime() - run.endedAt.getTime() <= gapMs
    ) {
      run.seq = seq;
      run.endedAt = createdAt;
      run.updateCount += 1;
      continue;
    }

    if (run !== null) {
      revisions.push(toRevision(run));
    }

    run = { fromSeq: seq, seq, actorId, startedAt: createdAt, endedAt: createdAt, updateCount: 1 };
  }

  if (run !== null) {
    revisions.push(toRevision(run));
  }

  return revisions;
}

function toRevision(run: {
  fromSeq: bigint;
  seq: bigint;
  actorId: string;
  startedAt: Date;
  endedAt: Date;
  updateCount: number;
}): Revision {
  return {
    seq: Number(run.seq),
    fromSeq: Number(run.fromSeq),
    actorId: run.actorId,
    startedAt: run.startedAt.toISOString(),
    endedAt: run.endedAt.toISOString(),
    updateCount: run.updateCount,
    name: null,
  };
}

/**
 * Attaches names to the revisions they were given, by their last sequence.
 *
 * Kept pure and separate from {@link coalesceRevisions} because a name is a fact from a
 * different table, looked up by the caller; folding the lookup into the coalescing would make
 * the one genuinely pure part of this module reach into the database.
 */
export function attachNames(
  revisions: readonly Revision[],
  names: ReadonlyMap<string, string>,
): readonly Revision[] {
  return revisions.map((revision) => {
    const name = names.get(String(revision.seq)) ?? null;
    return name === revision.name ? revision : { ...revision, name };
  });
}

/** The document's most recent sequence, or null when no such document is visible here. */
async function headSeqOf(
  sql: ScopedQuery,
  tenantId: string,
  docId: string,
): Promise<bigint | null> {
  const { rows } = await sql.query<{ head_seq: string }>(
    `SELECT head_seq FROM content_doc WHERE tenant_id = $1 AND doc_id = $2`,
    [tenantId, docId],
  );
  const row = rows[0];
  return row === undefined ? null : BigInt(row.head_seq);
}

/** Updates strictly after `afterSeq` and at or before `uptoSeq`, in order. */
async function updatesInRange(
  sql: ScopedQuery,
  tenantId: string,
  docId: string,
  afterSeq: bigint,
  uptoSeq: bigint,
  limit: number,
): Promise<UpdateRow[]> {
  const { rows } = await sql.query<UpdateRow>(
    `SELECT seq, update_bytes, actor_id, client_id, created_at
     FROM content_update
     WHERE tenant_id = $1 AND doc_id = $2 AND seq > $3 AND seq <= $4
     ORDER BY seq
     LIMIT $5`,
    [tenantId, docId, afterSeq.toString(), uptoSeq.toString(), limit],
  );

  return rows;
}

/** The tail of the update log at or before `beforeSeq` (or the whole log, when null), ascending. */
async function updateTail(
  sql: ScopedQuery,
  tenantId: string,
  docId: string,
  beforeSeq: bigint | null,
  take: number,
): Promise<UpdateRow[]> {
  const { rows } = await sql.query<UpdateRow>(
    beforeSeq === null
      ? `SELECT * FROM (
           SELECT seq, update_bytes, actor_id, client_id, created_at
           FROM content_update
           WHERE tenant_id = $1 AND doc_id = $2
           ORDER BY seq DESC
           LIMIT $3
         ) AS tail
         ORDER BY seq`
      : `SELECT * FROM (
           SELECT seq, update_bytes, actor_id, client_id, created_at
           FROM content_update
           WHERE tenant_id = $1 AND doc_id = $2 AND seq < $4
           ORDER BY seq DESC
           LIMIT $3
         ) AS tail
         ORDER BY seq`,
    beforeSeq === null ? [tenantId, docId, take] : [tenantId, docId, take, beforeSeq.toString()],
  );

  return rows;
}

/** Every named version of a document, ordered oldest first. */
export async function listNamedVersions(
  sql: ScopedQuery,
  tenantId: string,
  docId: string,
): Promise<readonly NamedVersion[]> {
  const { rows } = await sql.query<{
    seq: string;
    name: string;
    created_by: string;
    created_at: Date;
  }>(
    `SELECT seq, name, created_by, created_at
     FROM content_version
     WHERE tenant_id = $1 AND doc_id = $2
     ORDER BY seq`,
    [tenantId, docId],
  );

  return rows.map((row) => ({
    seq: Number(row.seq),
    name: row.name,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  }));
}

/**
 * A page of revisions ending at `before` (exclusive), newest first.
 *
 * **Reads a growing window of raw updates until it has proof the page is complete.** A
 * revision near the edge of whatever was fetched might really extend further back than the
 * window reaches, so the earliest revision found is only trusted once there is at least one
 * more, complete revision behind it - which is why this keeps widening the read rather than
 * taking the first batch at face value. It stops for one of two reasons: the window now holds
 * more revisions than were asked for (so the extra one vouches for the rest), or the window
 * came back short (so the start of the log was reached and there is nothing more to prove).
 */
export async function listRevisions(
  sql: ScopedQuery,
  tenantId: string,
  docId: string,
  options: { before?: number; limit: number },
): Promise<{ revisions: readonly Revision[]; hasMore: boolean }> {
  const limit = Math.max(1, options.limit);
  const beforeSeq = options.before === undefined ? null : BigInt(options.before);

  let take = Math.max(limit + 1, WINDOW_INITIAL);
  let coalesced: readonly Revision[] = [];
  let rowCount = 0;

  for (;;) {
    const rows = await updateTail(sql, tenantId, docId, beforeSeq, take);
    rowCount = rows.length;
    coalesced = coalesceRevisions(rows);

    if (coalesced.length > limit || rowCount < take || take >= WINDOW_CAP) {
      break;
    }

    take = Math.min(take * 2, WINDOW_CAP);
  }

  const hasMore = coalesced.length > limit;
  const kept = hasMore ? coalesced.slice(coalesced.length - limit) : coalesced;

  const names = await listNamedVersions(sql, tenantId, docId);
  const nameBySeq = new Map(names.map((version) => [String(version.seq), version.name]));

  // Newest first: `before` is the cursor a caller pages backward from, and the natural reading
  // order for "what changed" is most recent first.
  return { revisions: attachNames(kept, nameBySeq).slice().reverse(), hasMore };
}

/**
 * Reconstructs the document as it stood after sequence `seq`: the newest snapshot at or
 * before it, replayed forward with the updates after that up to and including `seq`.
 *
 * Returns null in exactly the two cases the contract names: `seq` is beyond the document's
 * head (there is no such state yet), or the base this reconstruction needed - a snapshot, or
 * the updates bridging it to `seq` - was pruned and no longer exists. The second case is
 * detected the same way either failure shows up: the replay cannot reach `seq` without a gap.
 */
export async function stateAt(
  sql: ScopedQuery,
  tenantId: string,
  docId: string,
  seq: number,
): Promise<Y.Doc | null> {
  const target = BigInt(seq);
  if (target < 0n) {
    return null;
  }

  const head = await headSeqOf(sql, tenantId, docId);
  if (head === null || target > head) {
    return null;
  }

  const snapshot = await snapshotAtOrBefore(sql, tenantId, docId, target);
  const state = new Y.Doc();
  let cursor = 0n;

  if (snapshot !== null) {
    Y.applyUpdate(state, new Uint8Array(snapshot.yjs_state));
    cursor = BigInt(snapshot.seq);
  }

  while (cursor < target) {
    const page = await updatesInRange(sql, tenantId, docId, cursor, target, REPLAY_PAGE);
    if (page.length === 0) {
      // Nothing bridges from here to `target`: the base this state needed is gone.
      return null;
    }

    for (const row of page) {
      const rowSeq = BigInt(row.seq);
      if (rowSeq !== cursor + 1n) {
        // A hole in the log between the base and `target` - pruning deleted what this
        // reconstruction needed.
        return null;
      }
      Y.applyUpdate(state, new Uint8Array(row.update_bytes));
      cursor = rowSeq;
    }
  }

  return state;
}

/**
 * Names a revision, pinning a snapshot at its sequence first if one does not already exist.
 *
 * **The pin is a bare `content_snapshot` row, not the full materialisation `writeSnapshotNow`
 * produces.** That function also replaces the item's live backlinks and search text, which is
 * correct for the current head and wrong here: naming an old revision must not make the
 * search index or the backlinks panel describe a state the document has since moved on from.
 * `prosemirror_json` and `plaintext` are left empty on a pinned historical snapshot for the
 * same reason - `stateAt` reconstructs from `yjs_state` alone, and nothing reads those two
 * columns for a seq that is not the head.
 *
 * Renaming is an upsert: naming the same seq again replaces the name rather than erroring,
 * which is what lets a mislabelled version be corrected without deleting and re-adding it.
 */
export async function nameVersion(
  sql: ScopedQuery,
  tenantId: string,
  docId: string,
  seq: number,
  name: string,
  createdBy: string,
): Promise<NamedVersion> {
  const target = BigInt(seq);

  const { rows: existing } = await sql.query<{ seq: string }>(
    `SELECT seq FROM content_snapshot WHERE tenant_id = $1 AND doc_id = $2 AND seq = $3`,
    [tenantId, docId, target.toString()],
  );

  if (existing.length === 0) {
    const state = await stateAt(sql, tenantId, docId, seq);
    if (state === null) {
      throw new Error(
        `Cannot name version at seq ${String(target)} of document ${docId}: that state cannot ` +
          'be reconstructed - it is beyond the head, or its base has been pruned.',
      );
    }

    await writeSnapshot(sql, {
      tenantId,
      docId,
      seq: target,
      yjsState: Y.encodeStateAsUpdate(state),
      prosemirrorJson: null,
      plaintext: '',
    });
  }

  const { rows } = await sql.query<{ created_at: Date }>(
    `INSERT INTO content_version (doc_id, seq, tenant_id, name, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (doc_id, seq) DO UPDATE
        SET name = EXCLUDED.name, created_by = EXCLUDED.created_by, created_at = now()
     RETURNING created_at`,
    [docId, target.toString(), tenantId, name, createdBy],
  );

  const row = rows[0];
  if (row === undefined) {
    throw new Error(`Naming version ${String(target)} of document ${docId} did not return a row.`);
  }

  return { seq, name, createdBy, createdAt: row.created_at.toISOString() };
}

/**
 * Removes a name, if one is there. Never removes the pinned snapshot itself - once unnamed, it
 * is an ordinary snapshot again, eligible for {@link pruneHistory} the next time it runs.
 */
export async function deleteNamedVersion(
  sql: ScopedQuery,
  tenantId: string,
  docId: string,
  seq: number,
): Promise<boolean> {
  const { rowCount } = await sql.query(
    `DELETE FROM content_version WHERE tenant_id = $1 AND doc_id = $2 AND seq = $3`,
    [tenantId, docId, BigInt(seq).toString()],
  );

  return (rowCount ?? 0) > 0;
}

/**
 * Enforces retention: everything older than `retentionDays`, down to the newest snapshot that
 * is itself old enough to be the new base.
 *
 * **The base is chosen, not assumed.** It is the newest snapshot taken at or before the
 * cutoff - the closest thing to the cutoff pruning may keep intact. Updates at or before its
 * sequence are exactly what it already encodes, so deleting them costs nothing a reader can
 * observe; updates after it, and the head, are never touched. Snapshots older than the base
 * are deleted in turn, except the ones a name in `content_version` has pinned - that is the
 * entire reason naming pins a snapshot rather than just recording a sequence number.
 *
 * A document with no snapshot at or before the cutoff has nothing safe to prune yet - there is
 * no base to fall back to - and this is a no-op for it.
 */
export async function pruneHistory(
  sql: ScopedQuery,
  tenantId: string,
  docId: string,
  retentionDays: number,
  now: Date = new Date(),
): Promise<{ updatesDeleted: number; snapshotsDeleted: number }> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  const { rows: baseRows } = await sql.query<{ seq: string }>(
    `SELECT seq FROM content_snapshot
     WHERE tenant_id = $1 AND doc_id = $2 AND created_at <= $3
     ORDER BY seq DESC
     LIMIT 1`,
    [tenantId, docId, cutoff.toISOString()],
  );

  const base = baseRows[0];
  if (base === undefined) {
    return { updatesDeleted: 0, snapshotsDeleted: 0 };
  }

  const baseSeq = base.seq;

  const { rowCount: updatesDeleted } = await sql.query(
    `DELETE FROM content_update
     WHERE tenant_id = $1 AND doc_id = $2 AND seq <= $3 AND created_at < $4`,
    [tenantId, docId, baseSeq, cutoff.toISOString()],
  );

  const { rowCount: snapshotsDeleted } = await sql.query(
    `DELETE FROM content_snapshot s
     WHERE s.tenant_id = $1 AND s.doc_id = $2 AND s.seq < $3
       AND NOT EXISTS (
         SELECT 1 FROM content_version v
         WHERE v.tenant_id = s.tenant_id AND v.doc_id = s.doc_id AND v.seq = s.seq
       )`,
    [tenantId, docId, baseSeq],
  );

  return { updatesDeleted: updatesDeleted ?? 0, snapshotsDeleted: snapshotsDeleted ?? 0 };
}
