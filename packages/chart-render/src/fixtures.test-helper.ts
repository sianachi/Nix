import type { ChartInput } from './types.js';

/** A small chart, unsplit unless series are given. Test-only. */
export function aChart(overrides: Partial<ChartInput> = {}): ChartInput {
  return {
    groupBy: 'status',
    measure: 'count',
    measureProperty: null,
    buckets: [
      { value: 'Todo', children: 3, total: null, cells: [] },
      { value: 'Doing', children: 1, total: null, cells: [] },
      { value: null, children: 2, total: null, cells: [] },
    ],
    chartKind: 'column',
    period: null,
    splitBy: null,
    from: null,
    to: null,
    series: [],
    otherSeries: 0,
    stacked: false,
    cumulative: false,
    rollingAverage: false,
    ...overrides,
  };
}
