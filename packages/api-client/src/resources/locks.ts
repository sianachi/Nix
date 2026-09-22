/** The item-lock resource: the only place item-lock URLs appear. */

import {
  defineCommand,
  defineQuery,
  type CommandEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import {
  itemLockSchema,
  noContentSchema,
  unlockItemResultSchema,
  type ItemLock,
  type UnlockItemResult,
} from '../schemas/index.js';

const lockKey = (itemId: string) => ['items', itemId, 'lock'] as const;

/** Whether an item's body is locked, and until when this session has it open. */
export const getItemLock = (itemId: string): QueryEndpoint<ItemLock> =>
  defineQuery<ItemLock>({
    operation: 'locks.get',
    path: `/api/v1/items/${itemId}/lock`,
    schema: itemLockSchema,
    cacheKey: lockKey(itemId),
  });

/**
 * Locks an item's body behind a password, or changes the password of an existing lock (which needs
 * `currentPassword`). The calling session is left unlocked.
 */
export const setItemLock = (
  itemId: string,
  password: string,
  currentPassword?: string,
): CommandEndpoint<undefined> =>
  defineCommand<undefined>({
    operation: 'locks.set',
    method: 'PUT',
    path: `/api/v1/items/${itemId}/lock`,
    body: currentPassword === undefined ? { password } : { password, currentPassword },
    schema: noContentSchema,
    invalidates: [lockKey(itemId)],
  });

/** Removes an item's lock. Needs the password. */
export const removeItemLock = (itemId: string, password: string): CommandEndpoint<undefined> =>
  defineCommand<undefined>({
    operation: 'locks.remove',
    method: 'POST',
    path: `/api/v1/items/${itemId}/lock/remove`,
    body: { password },
    schema: noContentSchema,
    invalidates: [lockKey(itemId)],
  });

/** Opens a locked body to this session for a while. */
export const unlockItem = (itemId: string, password: string): CommandEndpoint<UnlockItemResult> =>
  defineCommand<UnlockItemResult>({
    operation: 'locks.unlock',
    method: 'POST',
    path: `/api/v1/items/${itemId}/unlock`,
    body: { password },
    schema: unlockItemResultSchema,
    invalidates: [lockKey(itemId)],
  });

/** Closes a locked body to this session again, before its unlock runs out. */
export const relockItem = (itemId: string): CommandEndpoint<undefined> =>
  defineCommand<undefined>({
    operation: 'locks.relock',
    method: 'DELETE',
    path: `/api/v1/items/${itemId}/unlock`,
    schema: noContentSchema,
    invalidates: [lockKey(itemId)],
  });
