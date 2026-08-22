/**
 * A chart view's data: a container's children summarised into buckets, server-side.
 *
 * Server-side and not in the browser, because a chart tallied from a loaded page of a container
 * with three thousand children would be a picture of the first page presented as a picture of the
 * whole. ADR-0044 records the decision; what this file owns is the boundary parse.
 */

import { z } from 'zod';
import type { components } from '../generated/api.js';

export const chartBucketSchema = z.object({
  /**
   * The grouping property's value, or null for the children that have none.
   *
   * Unset is a bucket rather than an omission: a container half of whose children have no status is
   * mostly a container of unset things, and dropping them would misreport every proportion.
   */
  value: z.string().nullable(),

  children: z.int(),

  /** The measured property's total, or null when the chart counts rather than totals. */
  total: z.number().nullable(),
});

export const itemChartSchema = z.object({
  itemId: z.uuid(),
  viewId: z.string(),
  groupBy: z.string(),

  /** What each bar measures. An open string, matching every other view vocabulary on this wire. */
  measure: z.string(),
  measureProperty: z.string().nullable(),

  buckets: z.array(chartBucketSchema),

  /** Every child summarised, across every bucket including any left out. */
  children: z.int(),

  /** How many distinct values the grouping property takes, whether or not each one fitted. */
  distinctValues: z.int(),

  /**
   * Whether more buckets exist than were returned.
   *
   * Carried rather than inferred from a count, because inferring it is exactly the arithmetic a
   * client gets wrong once and then draws confidently forever.
   */
  truncated: z.boolean(),
});

export type ChartBucket = z.infer<typeof chartBucketSchema>;
export type ItemChart = z.infer<typeof itemChartSchema>;

/**
 * The compile-time tie to the generated contract: a field Core renames stops this package's build
 * rather than emptying a chart in front of somebody.
 */
const _itemChartContract = itemChartSchema satisfies z.ZodType<
  components['schemas']['ChartResponse']
>;
void _itemChartContract;
