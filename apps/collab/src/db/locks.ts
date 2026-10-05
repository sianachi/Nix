import type { ScopedQuery } from './tenant-scope.ts';

/**
 * Which of these items have their bodies locked, by their own lock or an ancestor's.
 *
 * **A lock covers its subtree.** A note inside a locked folder is as locked as the folder, so the
 * question walks the closure table - an embedded section whose source sits under a locked folder is
 * left out of an export even though the source itself carries no lock.
 *
 * **Only for the paths that read bodies below the item Core authorized.** A live session, the
 * updates route and history all ask Core about the one item they serve, and Core refuses a locked
 * body there. A subtree export and a template capture read their descendants straight from the
 * content tables, so they ask this instead and leave locked bodies out.
 *
 * Deliberately not "which of these has the caller unlocked": that is a per-credential grant Core
 * owns, and a second place deciding it would be the one that drifts. Every path that calls this
 * leaves a locked body out regardless of who is asking. This service's role can read only the
 * `tenant_id` and `item_id` columns of `item_lock`, never the verifier, and only the
 * `tenant_id`, `descendant_id` and `ancestor_id` columns of `item_closure`.
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
    `SELECT DISTINCT edge.descendant_id AS item_id
       FROM item_closure AS edge
       JOIN item_lock
         ON item_lock.tenant_id = edge.tenant_id
        AND item_lock.item_id = edge.ancestor_id
      WHERE edge.tenant_id = $1
        AND edge.descendant_id = ANY($2::uuid[])`,
    [tenantId, itemIds],
  );

  return new Set(rows.map((row) => row.item_id));
}
