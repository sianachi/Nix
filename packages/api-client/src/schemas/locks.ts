/**
 * An item's lock, as the calling session sees it.
 *
 * **A lock withholds an item's body; it does not encrypt it.** Core refuses the body to any session
 * that has not presented the password recently. Titles and properties stay visible, because they
 * are what a tree or a board needs to draw a row. A view must not describe a lock as encryption.
 *
 * **A lock covers the whole subtree.** A child of a locked item is locked by it, and a locked
 * item's children and views are withheld with its body - Core answers `items.locked` (423) to a
 * children list or a view under a lock this session has not opened.
 */

import { z } from 'zod';
import type { components } from '../generated/api.js';

export const itemLockSchema = z.object({
  /** Whether the item's body and children are behind a password - its own, or an ancestor's. */
  locked: z.boolean(),

  /**
   * When this session's unlock ends, or null while any lock covering the item is closed to it.
   * Another session - including the same person's elsewhere - has its own answer.
   */
  unlockedUntil: z.iso.datetime({ offset: true }).nullable(),

  /**
   * The item whose password opens this one next: the nearest covering lock this session has not
   * opened, or the nearest one when all are open. Null when nothing is locked. Unlocking and
   * locking again act on this item, which may be an ancestor.
   */
  lockItemId: z.uuid().nullable(),

  /** Whether the item has a lock of its own - the one setting, changing or removing acts on. */
  selfLocked: z.boolean(),
});

export type ItemLock = z.infer<typeof itemLockSchema>;

export const unlockItemResultSchema = z.object({
  unlockedUntil: z.iso.datetime({ offset: true }),
});

export type UnlockItemResult = z.infer<typeof unlockItemResultSchema>;

/** The compile-time tie to the generated contract. */
const _itemLockContract = itemLockSchema satisfies z.ZodType<
  components['schemas']['ItemLockResponse']
>;
void _itemLockContract;

const _unlockContract = unlockItemResultSchema satisfies z.ZodType<
  components['schemas']['UnlockItemResponse']
>;
void _unlockContract;
