/** The caller's bookmark resource: the only place bookmark URLs appear. */

import {
  defineCommand,
  defineQuery,
  type CommandEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import { noContentSchema, shelfSchema, type Shelf } from '../schemas/index.js';

const shelfKey = ['me', 'bookmarks'] as const;

/** The caller's readable bookmarks and the count hidden by permissions or trash. */
export const listBookmarks = (): QueryEndpoint<Shelf> =>
  defineQuery<Shelf>({
    operation: 'bookmarks.list',
    path: '/api/v1/me/bookmarks',
    schema: shelfSchema,
    cacheKey: shelfKey,
  });

/** Keeps an item for the caller. The operation is idempotent by contract. */
export const keepBookmark = (itemId: string): CommandEndpoint<undefined> =>
  defineCommand<undefined>({
    operation: 'bookmarks.keep',
    method: 'PUT',
    path: `/api/v1/items/${itemId}/bookmark`,
    schema: noContentSchema,
    invalidates: [shelfKey],
  });

/** Removes an item from the caller's shelf. The operation is idempotent by contract. */
export const removeBookmark = (itemId: string): CommandEndpoint<undefined> =>
  defineCommand<undefined>({
    operation: 'bookmarks.remove',
    method: 'DELETE',
    path: `/api/v1/items/${itemId}/bookmark`,
    schema: noContentSchema,
    invalidates: [shelfKey],
  });
