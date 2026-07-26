/**
 * Example resource schema: an item, the workspace's unit of content.
 *
 * This is the shape every future resource schema copies. Two rules make it
 * work: the schema is the source of truth and the TypeScript type is always
 * `z.infer` of it, never a hand-written interface that can drift; and the
 * schema is parsed exactly once, at the transport boundary, after which the
 * parsed object is frozen and flows inward without re-validation.
 *
 * When Core's OpenAPI document is generated into `src/generated/api.ts`, this
 * file gains one line per schema that ties the two together at compile time:
 *
 *   const _contract = itemSchema satisfies z.ZodType<components['schemas']['Item']>;
 *
 * so a backend field rename fails the frontend build instead of failing at
 * runtime in front of a user.
 */

import { z } from 'zod';

export const itemKindSchema = z.enum(['document', 'folder', 'file']);
export type ItemKind = z.infer<typeof itemKindSchema>;

export const itemSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  parentId: z.uuid().nullable(),
  kind: itemKindSchema,
  title: z.string(),
  updatedAt: z.iso.datetime(),
});

export type Item = z.infer<typeof itemSchema>;
