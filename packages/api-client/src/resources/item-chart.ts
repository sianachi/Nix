/**
 * The chart resource: the only place the chart URL appears.
 *
 * One read, and deliberately no way to send the grouping. The stored view is the whole
 * configuration - a caller who could supply a grouping property could bucket any property of every
 * child, including ones no schema declares - so this resource names the view and nothing else.
 * The configuration is edited through the ordinary views endpoint.
 */

import { defineQuery, type QueryEndpoint } from '../endpoints.js';
import { itemChartSchema, type ItemChart } from '../schemas/index.js';

/** Cache key for one drawing of one chart view. */
const itemChartKey = (itemId: string, viewId: string): readonly string[] => [
  'items',
  itemId,
  'chart',
  viewId,
];

/**
 * Summarises a container's children the way one of its chart views says to.
 *
 * Computed over every child rather than over a loaded page, which is what a chart tallied in the
 * browser could not honestly claim. An item or view that is not visible answers 404; a chart that
 * cannot be drawn as configured answers `chart.not_configured` rather than empty buckets, so an
 * unfinished configuration does not read as an empty container.
 *
 * @param itemId The container to summarise.
 * @param viewId Which of its views to draw.
 * @returns The buckets, and the totals that say what did not fit.
 */
export const itemChart = (itemId: string, viewId: string): QueryEndpoint<ItemChart> =>
  defineQuery<ItemChart>({
    operation: 'chart.run',
    path: `/api/v1/items/${itemId}/chart?view=${encodeURIComponent(viewId)}`,
    schema: itemChartSchema,
    cacheKey: itemChartKey(itemId, viewId),
  });
