import { describe, expect, it } from 'vitest';

import {
  CHART_HEIGHT,
  axisTickIndexes,
  columnGeometry,
  lineGeometry,
  niceMaximum,
  pieGeometry,
} from './geometry.js';

describe('chart geometry', () => {
  it('rounds a count scale up to an even step', () => {
    expect(niceMaximum(3, true)).toBe(4);
    expect(niceMaximum(0, true)).toBe(2);
    expect(niceMaximum(2.5, false)).toBe(2.5);
  });

  it('stacks columns on one another and never draws a negative', () => {
    const geometry = columnGeometry({
      series: [{ values: [2, -1] }, { values: [2, 1] }],
      count: 2,
      whole: true,
      stacked: true,
    });
    expect(geometry.maximum).toBe(4);
    const [first, second, third] = geometry.rects;
    expect(first?.height).toBe(CHART_HEIGHT / 2);
    expect(second?.y).toBe(0);
    expect(third?.height).toBe(0);
  });

  it('breaks a line where a value is missing', () => {
    const geometry = lineGeometry({
      series: [{ values: [1, 2, 3] }],
      count: 3,
      whole: true,
      area: false,
      stacked: false,
      averages: [[null, 1, 2]],
    });
    expect(geometry.lines[0]).toMatch(/^M0,/);
    expect(geometry.averages[0]?.startsWith('M300,')).toBe(true);
    expect(geometry.points).toHaveLength(3);
  });

  it('draws a single share as a whole circle and skips empty slices', () => {
    expect(pieGeometry([5, 0]).slices).toEqual([{ index: 0, share: 1, d: null }]);
    expect(pieGeometry([1, 1]).slices).toHaveLength(2);
    expect(pieGeometry([0]).total).toBe(0);
  });

  it('labels first, middle and last bucket', () => {
    expect(axisTickIndexes(5)).toEqual([0, 2, 4]);
    expect(axisTickIndexes(1)).toEqual([0]);
  });
});
