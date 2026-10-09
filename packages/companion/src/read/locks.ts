import { locks } from '@nix/api-client';
import type { CompanionPorts } from '../ports.js';

/** The most distinct items one read checks for a lock; a read that touched more is treated as
 * having returned locked content, rather than spending a request per row. */
export const MAX_LOCK_CHECKS = 25;

/**
 * Whether any of `itemIds` sits under a lock - its own or an ancestor's - as this credential sees
 * it. A read whose content came from such an item reports it (`WorkspaceToolOutcome.lockedContent`)
 * so the web gate can stop the same turn's writes from applying without asking: the pet's reads
 * carry the owner's unlocks (ADR-0056), and text it read behind a lock must not be copied out
 * unattended.
 *
 * Fails closed: an unreadable lock state, or more items than `MAX_LOCK_CHECKS`, counts as locked.
 */
export async function anyUnderLock(
  ports: CompanionPorts,
  itemIds: readonly (string | null | undefined)[],
  signal: AbortSignal,
): Promise<boolean> {
  const distinct = [...new Set(itemIds.filter((id): id is string => Boolean(id)))];
  if (distinct.length === 0) return false;
  if (distinct.length > MAX_LOCK_CHECKS) return true;
  const states = await Promise.allSettled(
    distinct.map((id) => ports.core.query(locks.getItemLock(id), { signal, forceRefresh: true })),
  );
  return states.some((state) => state.status === 'rejected' || state.value.locked);
}
