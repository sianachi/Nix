import { describe, expect, it } from 'vitest';

import { aChart } from './fixtures.test-helper.js';
import { labelsFor } from './model.js';
import { renderChartSvg } from './svg.js';

const labels = labelsFor([], 'Unset');
const options = { labels, idPrefix: 'c1', locale: 'en-GB', caption: 'Items by status' };

describe('renderChartSvg', () => {
  it('styles by class only, so the page ground decides the colour', () => {
    const drawn = renderChartSvg(aChart(), options);
    expect(drawn.svg).toContain('class="nix-chart-s0"');
    expect(drawn.svg).not.toMatch(/style=|#[0-9a-f]{6}/i);
    expect(drawn.svg).toContain('aria-hidden="true"');
  });

  it('carries every figure in the table', () => {
    const drawn = renderChartSvg(aChart(), options);
    expect(drawn.table.rows).toEqual([
      { label: 'Todo', values: ['3'] },
      { label: 'Doing', values: ['1'] },
      { label: 'Unset', values: ['2'] },
    ]);
  });

  it('escapes labels from the data', () => {
    const drawn = renderChartSvg(
      aChart({ buckets: [{ value: '<script>', children: 1, total: null, cells: [] }] }),
      options,
    );
    expect(drawn.svg).not.toContain('<script>');
    expect(drawn.svg).toContain('&lt;script&gt;');
  });

  it('ranks pie slices and reports shares', () => {
    const drawn = renderChartSvg(aChart({ chartKind: 'pie' }), options);
    expect(drawn.table.rows.map((row) => row.values[1])).toEqual(['50', '33.33', '16.67']);
    expect(drawn.legend).toHaveLength(3);
  });

  it('is deterministic', () => {
    expect(renderChartSvg(aChart({ chartKind: 'line' }), options)).toEqual(
      renderChartSvg(aChart({ chartKind: 'line' }), options),
    );
  });
});
