/**
 * The container-views resource: the only place the views URL appears.
 *
 * One read, summary-shaped (see the schema). Pairs with the item-query resource: this says which
 * views a container offers and which can render, and `itemQuery` runs one of them.
 */

import { defineQuery, type QueryEndpoint } from '../endpoints.js';
import { containerViewsSchema, type ContainerViews } from '../schemas/index.js';

/** The views a container offers, which cannot currently render, and which one opens. */
export const containerViews = (itemId: string): QueryEndpoint<ContainerViews> =>
  defineQuery<ContainerViews>({
    operation: 'views.get',
    path: `/api/v1/items/${itemId}/views`,
    schema: containerViewsSchema,
    cacheKey: ['items', itemId, 'views'],
  });
