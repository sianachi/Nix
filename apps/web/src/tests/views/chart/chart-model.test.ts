import { describe, expect, it } from 'vitest';

import {
  bucketLabel,
  chartKindOf,
  cumulative,
  plottedSeries,
  seriesStyle,
  trailingAverage,
} from '../../../views/chart/chart-model';
import { aSplitChart, aTimeChart } from './chart-fixtures';

describe('the chart model', () => {
  it('draws a type it does not know as bars', () => {
    expect(chartKindOf('line')).toBe('line');
    expect(chartKindOf('radar')).toBe('bar');
    expect(chartKindOf(null)).toBe('bar');
  });

  it('names a period by what it spans', () => {
    expect(bucketLabel('2026-10-01', 'quarter')).toBe('Q4 2026');
    expect(bucketLabel('2026-01-01', 'year')).toBe('2026');
    expect(bucketLabel('2026-10-05', 'week')).toMatch(/^Week of /);
    expect(bucketLabel('Open', null)).toBe('Open');
    expect(bucketLabel(null, null)).toMatch(/unset/i);
  });

  it('keeps a running total', () => {
    expect(cumulative([1, 0, 3, 2])).toEqual([1, 1, 4, 6]);
  });

  it('averages only once a full span of periods exists', () => {
    expect(trailingAverage([1, 2, 3, 4], 3)).toEqual([null, null, 2, 3]);
    expect(trailingAverage([7, 7, 7, 7, 7, 7, 7])).toEqual([null, null, null, null, null, null, 7]);
  });

  it('plots an unsplit chart as one series named for its measure', () => {
    const [only, ...rest] = plottedSeries(aTimeChart());

    expect(rest).toEqual([]);
    expect(only?.label).toBe('Items');
    expect(only?.values.slice(0, 3)).toEqual([1, 2, 0]);
    expect(plottedSeries(aTimeChart(), { cumulative: true })[0]?.values.slice(0, 3)).toEqual([
      1, 3, 3,
    ]);
  });

  it('plots each series from its cells, the unset one named as unset', () => {
    const series = plottedSeries(aSplitChart());

    expect(series.map((entry) => entry.label)).toEqual(['Ada', expect.stringMatching(/unset/i)]);
    expect(series.map((entry) => entry.values)).toEqual([
      [4, 1],
      [2, 2],
    ]);
  });

  it('tells twelve series apart by tone or pattern, and Other from all of them', () => {
    const styles = Array.from({ length: 12 }, (_, index) => seriesStyle(index, false));
    const signatures = new Set(styles.map((style) => `${style.fill}|${style.dash ?? ''}`));

    expect(signatures.size).toBe(12);
    expect(styles.map((style) => style.fill)).not.toContain(seriesStyle(0, true).fill);
  });
});
