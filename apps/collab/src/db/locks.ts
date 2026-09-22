import type { ScopedQuery } from './tenant-scope.ts';

/**
 * Which of these items have their bodies locked.
 *
 * **Only for the paths that read bodies below the item Core authorized.** A live session, the
 * updates route and history all ask Core about the one item they serve, and Core refuses a locked
 * body there. A subtree export and a template capture read their descendants straight from the
 * content tables, so they ask this instead and leave locked bodies out.
 *
 * Deliberately not "which of these has the caller unlocked": that is a per-credential grant Core
 * owns, and a second place deciding it would be the one that drifts. Every path that calls this
 * leaves a locked body out regardless of who is asking. This service's role can read only the
 * `tenant_id` and `item_id` columns of `item_lock`, never the verifier.
 */
export async function lockedAmong(
  sql: ScopedQuery,
  tenantId: string,
  itemIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (itemIds.length === 0) {
    return new Set();
  }

  const { rows } = await sql.query<{ item_id: string }>(
    `SELECT item_id FROM item_lock WHERE tenant_id = $1 AND item_id = ANY($2::uuid[])`,
    [tenantId, itemIds],
  );

  return new Set(rows.map((row) => row.item_id));
}
