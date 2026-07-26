/**
 * Cursor pagination is the house style end to end. There is no page number
 * anywhere in this package: a list response carries the items it has and an
 * opaque cursor for the next slice, and consumers walk it with an async
 * iterator (`NixClient.paginate`) rather than asking for "page 3".
 *
 * `nextCursor` is `null` - not absent - on the last page, so exhaustion is a
 * value the schema can prove rather than a missing-key inference.
 */

import { z } from 'zod';

export const cursorPageSchema = <TItem extends z.ZodType>(
  item: TItem,
): z.ZodObject<{ items: z.ZodArray<TItem>; nextCursor: z.ZodNullable<z.ZodString> }> =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });

export interface CursorPage<TItem> {
  readonly items: readonly TItem[];
  readonly nextCursor: string | null;
}

/** Query-string parameter names Core uses for cursor pagination. */
export const CURSOR_PARAM = 'cursor';
export const PAGE_SIZE_PARAM = 'limit';
