/**
 * An item's lock, as the calling session sees it.
 *
 * **A lock withholds an item's body; it does not encrypt it.** Core refuses the body to any session
 * that has not presented the password recently. Titles and properties stay visible, because they
 * are what a tree or a board needs to draw a row. A view must not describe a lock as encryption.
 */

import { z } from 'zod';
import type { components } from '../generated/api.js';

export const itemLockSchema = z.object({
  /** Whether the item's body is behind a password. */
  locked: z.boolean(),

  /**
   * When this session's unlock ends, or null when it holds none. Another session - including the
   * same person's elsewhere - has its own answer.
   */
  unlockedUntil: z.iso.datetime({ offset: true }).nullable(),
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
