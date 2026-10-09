import { itemChartSchema, type ItemChart } from '@nix/api-client';

/** A chart payload as the client parses it, with the given fields over a plain bar chart. */
export function aChart(over: Record<string, unknown> = {}): ItemChart {
  return itemChartSchema.parse({
    itemId: '11111111-1111-4111-8111-111111111111',
    viewId: 'v1',
    groupBy: 'status',
    measure: 'count',
    measureProperty: null,
    buckets: [
      { value: 'Todo', children: 6, total: null },
      { value: 'Done', children: 3, total: null },
      { value: null, children: 1, total: null },
    ],
    children: 10,
    distinctValues: 3,
    truncated: false,
    ...over,
  });
}

/** Consecutive monthly buckets from January 2026, one per value. */
export function monthly(values: readonly number[]): Record<string, unknown>[] {
  return values.map((children, index) => ({
    value: `2026-${String(index + 1).padStart(2, '0')}-01`,
    children,
    total: null,
  }));
}

/** A line chart over twelve months. */
export function aTimeChart(over: Record<string, unknown> = {}): ItemChart {
  const values = [1, 2, 0, 4, 5, 3, 2, 6, 1, 0, 4, 2];
  return aChart({
    groupBy: 'done_on',
    chartKind: 'line',
    period: 'month',
    from: '2026-01-01',
    to: '2026-12-31',
    buckets: monthly(values),
    children: values.reduce((sum, value) => sum + value, 0),
    distinctValues: values.length,
    ...over,
  });
}

/** A column chart over three statuses split into two owners. */
export function aSplitChart(over: Record<string, unknown> = {}): ItemChart {
  return aChart({
    chartKind: 'column',
    splitBy: 'owner',
    buckets: [
      {
        value: 'Todo',
        children: 6,
        total: null,
        cells: [
          { children: 4, total: null },
          { children: 2, total: null },
        ],
      },
      {
        value: 'Done',
        children: 3,
        total: null,
        cells: [
          { children: 1, total: null },
          { children: 2, total: null },
        ],
      },
    ],
    series: [
      { value: 'Ada', other: false, children: 5, total: null },
      { value: null, other: false, children: 4, total: null },
    ],
    children: 9,
    distinctValues: 2,
    ...over,
  });
}

/** A year grid of 371 days ending on a Sunday, with a value every third day. */
export function aYearChart(): ItemChart {
  const start = Date.UTC(2025, 9, 6); // A Monday.
  const buckets = Array.from({ length: 371 }, (_, index) => ({
    value: new Date(start + index * 86_400_000).toISOString().slice(0, 10),
    children: index % 3 === 0 ? (index % 9) + 1 : 0,
    total: null,
  }));
  return aChart({
    groupBy: 'done_on',
    chartKind: 'year',
    period: 'day',
    from: buckets[0]?.value,
    to: buckets.at(-1)?.value,
    buckets,
    children: buckets.reduce((sum, bucket) => sum + bucket.children, 0),
    distinctValues: 371,
  });
}
