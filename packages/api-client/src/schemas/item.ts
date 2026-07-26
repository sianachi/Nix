/**
 * An item: the workspace's universal object — a note, task, folder, board or file.
 *
 * Two rules make this file work, and they are the pattern every resource schema copies. The schema
 * is the source of truth and the TypeScript type is always `z.infer` of it, never a hand-written
 * interface that can drift. And the `satisfies` line at the bottom ties it to the generated
 * contract, so a field the backend renames fails this package's build instead of failing at
 * runtime in front of a user.
 *
 * This schema was previously a guess made before the contract existed, and it was wrong in three
 * ways worth remembering: it called the field `kind` and typed it as an enum, and it was missing
 * `seq`, `lifecycleState` and `createdAt`. The enum was the interesting mistake — item kinds are
 * added as a feature, so an enum would have broken every client each time one landed.
 */

import { z } from 'zod';
import type { components } from '../generated/api.js';

/**
 * The item's kind, as an open string.
 *
 * Deliberately not an enum. Folder, note, task, board and file are what exist today; the set is
 * open by design and a client is expected to render an unknown kind generically rather than fail
 * to parse the response that carried it.
 */
export const itemTypeSchema = z.string();

/** Kinds this build renders specially. Anything else falls back to a generic row. */
export const KNOWN_ITEM_TYPES = ['folder', 'note', 'task', 'board', 'file'] as const;
export type KnownItemType = (typeof KNOWN_ITEM_TYPES)[number];

/** Where an item sits in the deletion lifecycle. Open for the same reason as the kind. */
export const itemLifecycleStateSchema = z.string();

/**
 * Sibling position.
 *
 * The contract types this as `number | string` because it is a 64-bit integer, and values beyond
 * `Number.MAX_SAFE_INTEGER` cannot survive a round trip through a JavaScript number. Real
 * positions are small — they advance in gaps of a thousand — but the schema accepts what the
 * contract permits rather than what we expect to see, because the day one exceeds it the honest
 * outcome is a wide type rather than a silently rounded sort order.
 */
export const itemSequenceSchema = z.union([z.number(), z.string()]);

export const itemSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  parentId: z.uuid().nullable(),
  type: itemTypeSchema,
  title: z.string(),
  seq: itemSequenceSchema,
  lifecycleState: itemLifecycleStateSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type Item = z.infer<typeof itemSchema>;

/**
 * The compile-time tie to the generated contract.
 *
 * If Core renames a field or changes a type, this line stops compiling and the failure lands here,
 * in the package that owns the boundary, rather than in a component at runtime.
 */
const _itemContract = itemSchema satisfies z.ZodType<components['schemas']['ItemResponse']>;
void _itemContract;
