import type { StructureView } from '@nix/structure-spec';
import { describe, expect, it } from 'vitest';

import { toViewRequest } from './create-structured.js';

describe('toViewRequest', () => {
  it('carries the type, time axis and series of a chart view to Core', () => {
    const view: StructureView = {
      id: 'chart',
      name: 'Done per week',
      kind: 'chart',
      columns: [],
      groupBy: 'done_on',
      groupOrder: [],
      dateProperty: null,
      sortBy: null,
      sortDescending: false,
      mode: null,
      coverProperty: null,
      endDateProperty: null,
      cardSize: null,
      layout: null,
      filters: [],
      measure: 'count',
      measureProperty: null,
      chart: {
        kind: 'line',
        period: 'week',
        splitBy: 'project',
        lastPeriods: null,
        from: null,
        to: null,
        cumulative: null,
        rollingAverage: null,
        stacked: null,
      },
    };

    expect(toViewRequest(view).chart).toEqual(view.chart);
    const { chart: _chart, ...unconfigured } = view;
    void _chart;
    expect(toViewRequest(unconfigured).chart).toBeNull();
  });

  it('keeps a custom view program when the pet rewrites the view set', () => {
    const view: StructureView = {
      id: 'mine',
      name: 'Mine',
      kind: 'custom',
      columns: [],
      groupBy: null,
      groupOrder: [],
      dateProperty: null,
      sortBy: null,
      sortDescending: false,
      mode: null,
      coverProperty: null,
      endDateProperty: null,
      cardSize: null,
      layout: null,
      filters: [],
      program: 'root = Stack([])',
    };

    expect(toViewRequest(view).program).toBe('root = Stack([])');
  });
});
