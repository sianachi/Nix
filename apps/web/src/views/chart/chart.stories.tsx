import { itemChartSchema, type ItemChart } from '@nix/api-client';
import { useState, type ReactElement } from 'react';

import type { PropertyDefinition, View } from '../core/container-model';
import { StructuredViewConfiguration } from '../core/structured-view-configuration';
import { ChartBody } from './chart-view';

/**
 * Every chart type, on both grounds and at phone width.
 *
 * Fixtures go through the client's own schema, so a story renders exactly the shape a server
 * response parses to. The year grid is fixed to a known year so the story does not drift.
 */

function chart(over: Record<string, unknown>): ItemChart {
  return itemChartSchema.parse({
    itemId: '11111111-1111-4111-8111-111111111111',
    viewId: 'chart',
    groupBy: 'Status',
    measure: 'count',
    measureProperty: null,
    buckets: [
      { value: 'Todo', children: 14, total: null },
      { value: 'Doing', children: 6, total: null },
      { value: 'Done', children: 23, total: null },
      { value: null, children: 3, total: null },
    ],
    children: 46,
    distinctValues: 4,
    truncated: false,
    ...over,
  });
}

const MONTH_VALUES = [4, 7, 3, 9, 12, 8, 5, 11, 14, 9, 6, 10];
const OWNERS = ['Ada', 'Grace', 'Linus'];

function months(values: readonly number[]): { value: string; children: number; total: null }[] {
  return values.map((children, index) => ({
    value: `2026-${String(index + 1).padStart(2, '0')}-01`,
    children,
    total: null,
  }));
}

const timeChart = (kind: string) =>
  chart({
    groupBy: 'Done on',
    chartKind: kind,
    period: 'month',
    from: '2026-01-01',
    to: '2026-12-31',
    buckets: months(MONTH_VALUES),
    children: MONTH_VALUES.reduce((sum, value) => sum + value, 0),
    distinctValues: 12,
    unplaced: 2,
  });

const splitChart = (kind: string) => {
  const buckets = months(MONTH_VALUES).map((bucket, index) => {
    const cells = OWNERS.map((_, owner) => ({
      children: Math.max(0, Math.round(bucket.children / 3) + ((index + owner) % 3) - 1),
      total: null,
    }));
    return { ...bucket, children: cells.reduce((sum, cell) => sum + cell.children, 0), cells };
  });
  return chart({
    groupBy: 'Done on',
    chartKind: kind,
    period: 'month',
    splitBy: 'Owner',
    from: '2026-01-01',
    to: '2026-12-31',
    buckets,
    series: OWNERS.map((value, owner) => ({
      value,
      other: false,
      children: buckets.reduce((sum, bucket) => sum + (bucket.cells[owner]?.children ?? 0), 0),
      total: null,
    })),
    children: buckets.reduce((sum, bucket) => sum + bucket.children, 0),
    distinctValues: 12,
  });
};

const yearChart = (() => {
  const start = Date.UTC(2025, 9, 6);
  const buckets = Array.from({ length: 371 }, (_, index) => ({
    value: new Date(start + index * 86_400_000).toISOString().slice(0, 10),
    children: (index * 7) % 5 === 0 ? 0 : ((index * 13) % 6) + (index % 7 === 5 ? 0 : 1),
    total: null,
  }));
  return chart({
    groupBy: 'Done on',
    chartKind: 'year',
    period: 'day',
    from: buckets[0]?.value,
    to: buckets.at(-1)?.value,
    buckets,
    children: buckets.reduce((sum, bucket) => sum + bucket.children, 0),
    distinctValues: 371,
  });
})();

function Stage({
  children,
  narrow = false,
}: {
  readonly children: ReactElement;
  readonly narrow?: boolean;
}): ReactElement {
  return (
    <div className={narrow ? 'w-full max-w-sm p-4' : 'mx-auto w-full max-w-4xl p-6'}>
      {children}
    </div>
  );
}

const dark = { globals: { ground: 'dark' } };

export default { title: 'Nix/Charts', parameters: { layout: 'padded' } };

export const Bars = {
  render: (): ReactElement => (
    <Stage>
      <ChartBody chart={chart({})} />
    </Stage>
  ),
};
export const BarsDark = { ...Bars, ...dark };

export const Columns = {
  render: (): ReactElement => (
    <Stage>
      <ChartBody chart={timeChart('column')} />
    </Stage>
  ),
};
export const ColumnsDark = { ...Columns, ...dark };

export const StackedColumns = {
  render: (): ReactElement => (
    <Stage>
      <ChartBody chart={splitChart('column')} />
    </Stage>
  ),
};
export const StackedColumnsDark = { ...StackedColumns, ...dark };

export const Pie = {
  render: (): ReactElement => (
    <Stage>
      <ChartBody chart={chart({ chartKind: 'pie' })} />
    </Stage>
  ),
};
export const PieDark = { ...Pie, ...dark };

export const LineWithDerivedLines = {
  render: (): ReactElement => (
    <Stage>
      <ChartBody chart={timeChart('line')} cumulative={false} rollingAverage />
    </Stage>
  ),
};
export const LineWithDerivedLinesDark = { ...LineWithDerivedLines, ...dark };

export const RunningTotal = {
  render: (): ReactElement => (
    <Stage>
      <ChartBody chart={timeChart('line')} cumulative />
    </Stage>
  ),
};

export const MultiLine = {
  render: (): ReactElement => (
    <Stage>
      <ChartBody chart={splitChart('line')} />
    </Stage>
  ),
};
export const MultiLineDark = { ...MultiLine, ...dark };

export const StackedArea = {
  render: (): ReactElement => (
    <Stage>
      <ChartBody chart={splitChart('area')} />
    </Stage>
  ),
};
export const StackedAreaDark = { ...StackedArea, ...dark };

export const YearGridChart = {
  name: 'Year grid',
  render: (): ReactElement => (
    <Stage>
      <ChartBody chart={yearChart} />
    </Stage>
  ),
};
export const YearGridChartDark = { ...YearGridChart, name: 'Year grid dark', ...dark };

export const PhoneWidth = {
  render: (): ReactElement => (
    <Stage narrow>
      <ChartBody chart={splitChart('column')} />
    </Stage>
  ),
};
export const PhoneWidthYearGrid = {
  render: (): ReactElement => (
    <Stage narrow>
      <ChartBody chart={yearChart} />
    </Stage>
  ),
};

const FIELDS = [
  { key: 'status', label: 'Status', type: 'select', options: ['Todo', 'Done'], required: false },
  { key: 'done_on', label: 'Done on', type: 'date', options: [], required: false },
  { key: 'owner', label: 'Owner', type: 'select', options: OWNERS, required: false },
] as PropertyDefinition[];

function EditorStory(): ReactElement {
  const [view, setView] = useState<View>({
    id: 'chart',
    name: 'Done per month',
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
    chart: {
      kind: 'line',
      period: 'month',
      splitBy: null,
      lastPeriods: 12,
      from: null,
      to: null,
      cumulative: null,
      rollingAverage: true,
    },
  });
  return (
    <Stage narrow>
      <div className="flex flex-col gap-3">
        <StructuredViewConfiguration
          view={view}
          fields={FIELDS}
          onChange={setView}
          showSort={false}
        />
      </div>
    </Stage>
  );
}

export const Options = { render: (): ReactElement => <EditorStory /> };
export const OptionsDark = { ...Options, ...dark };
