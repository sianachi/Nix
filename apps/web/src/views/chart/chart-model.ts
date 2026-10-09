import type { ChartBucket, ChartSeries, ItemChart } from '@nix/api-client';

import { formatCalendarDay } from '../../lib/date-format';
import { UNSET_LABEL, type PropertyDefinition } from '../core/container-model';

/**
 * The pure arithmetic and vocabulary behind every chart type: what a bucket measures, what a period
 * or a value is called, the derived lines, and how a series is told apart from its neighbours.
 *
 * Nothing here draws. Each renderer reads it, so a column chart and the table under it can never
 * disagree about a figure or a name.
 */

/** Every chart type this build draws. Core's `ChartKinds` is the authority on the words. */
export const CHART_KINDS = ['bar', 'column', 'pie', 'line', 'area', 'year'] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

/** The types that need an ordered, dated axis: Core refuses them without a period. */
export const TIME_AXIS_KINDS: ReadonlySet<ChartKind> = new Set(['line', 'area', 'year']);

export const CHART_KIND_LABELS: Record<ChartKind, string> = {
  bar: 'Bars',
  column: 'Columns',
  pie: 'Pie',
  line: 'Line',
  area: 'Area',
  year: 'Year grid',
};

/** Every period a time axis can count by, in the order an editor offers them. */
export const CHART_PERIODS = ['day', 'week', 'month', 'quarter', 'year'] as const;
export type ChartPeriod = (typeof CHART_PERIODS)[number];

export const CHART_PERIOD_LABELS: Record<ChartPeriod, string> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
  quarter: 'Quarter',
  year: 'Year',
};

/** The most periods a time axis draws (Core's `ChartOptions.MaximumPeriods`): one year grid of days. */
export const MAXIMUM_CHART_PERIODS = 371;

/** The most series drawn by name (Core's `ChartFolding.MaximumSeries`); the rest share Other. */
export const MAXIMUM_SERIES = 6;

/** How many periods the trailing average spans. */
export const AVERAGE_SPAN = 7;

/** A type this build draws, or bars for one it does not know - what an older build owes a newer view. */
export function chartKindOf(value: string | null | undefined): ChartKind {
  return (CHART_KINDS as readonly string[]).includes(value ?? '') ? (value as ChartKind) : 'bar';
}

export function isChartPeriod(value: string | null | undefined): value is ChartPeriod {
  return (CHART_PERIODS as readonly string[]).includes(value ?? '');
}

/** "1 item", "3 items". */
export function countOf(count: number, noun: string, plural = `${noun}s`): string {
  return `${String(count)} ${count === 1 ? noun : plural}`;
}

/**
 * What a property and its stored values are called, from the container's own definitions.
 *
 * The chart endpoint speaks in property keys and raw stored values, which are what Core can group
 * by; a person reads labels. A key no definition names is shown as itself rather than hidden.
 */
export interface ChartLabels {
  /** A property's label, or the key itself when no definition names it. */
  readonly property: (key: string | null) => string;
  /** A stored value as a person reads it: a checkbox's "Checked", an absent value's "Unset". */
  readonly value: (key: string | null, value: string | null) => string;
}

export function chartLabels(fields: readonly PropertyDefinition[]): ChartLabels {
  const byKey = new Map(fields.map((field) => [field.key, field]));
  return {
    property: (key) => (key === null ? '' : (byKey.get(key)?.label ?? key)),
    value: (key, value) => {
      if (value === null) {
        return UNSET_LABEL;
      }
      const type = key === null ? undefined : byKey.get(key)?.type;
      if (type === 'checkbox' || type === 'completion') {
        return value === 'true' ? 'Checked' : value === 'false' ? 'Not checked' : value;
      }
      return value;
    },
  };
}

/** Labels that know no definitions: keys and values as stored. */
export const RAW_LABELS: ChartLabels = chartLabels([]);

/**
 * What a bucket or cell is as large as.
 *
 * A bucket whose children carry no number totals null rather than zero - "nothing to add up" is
 * not "adds up to nothing" - but a mark has to be some size, so null draws as an empty one. The
 * figure beside it still says what it is.
 */
export function measureOf(
  entry: { readonly children: number; readonly total: number | null },
  totals: boolean,
): number {
  return totals ? (entry.total ?? 0) : entry.children;
}

/** The figure as a person reads it: whole numbers plain, fractions to two places. */
export function formatMeasure(value: number | null): string {
  if (value === null) {
    return '-';
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** A stored day as a person reads it - "6 Oct 2025" in their locale - or the text itself. */
export function formatDay(day: string | null): string {
  return day === null ? '' : (formatCalendarDay(day) ?? day);
}

/** A period's start date as the person reads it, long or short. */
export function bucketLabel(
  value: string | null,
  period: string | null,
  labels: ChartLabels = RAW_LABELS,
  groupBy: string | null = null,
  short = false,
): string {
  if (value === null) {
    return UNSET_LABEL;
  }
  if (!isChartPeriod(period)) {
    return labels.value(groupBy, value);
  }

  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const options = (parts: Intl.DateTimeFormatOptions) =>
    date.toLocaleDateString(undefined, { ...parts, timeZone: 'UTC' });

  switch (period) {
    case 'day':
      return short
        ? options({ day: 'numeric', month: 'short' })
        : options({ day: 'numeric', month: 'short', year: 'numeric' });
    case 'week':
      return short
        ? options({ day: 'numeric', month: 'short' })
        : `Week of ${options({ day: 'numeric', month: 'short', year: 'numeric' })}`;
    case 'month':
      return short ? options({ month: 'short' }) : options({ month: 'short', year: 'numeric' });
    case 'quarter':
      return `Q${String(Math.floor(date.getUTCMonth() / 3) + 1)}${short ? '' : ` ${String(date.getUTCFullYear())}`}`;
    case 'year':
      return String(date.getUTCFullYear());
  }
}

/** What a series is called in a legend and a table header. */
export function seriesLabel(
  series: ChartSeries,
  otherValues: number,
  labels: ChartLabels = RAW_LABELS,
  splitBy: string | null = null,
): string {
  if (series.other) {
    return `Other (${countOf(otherValues, 'value')})`;
  }
  return labels.value(splitBy, series.value);
}

/** The running total of a run of values. */
export function cumulative(values: readonly number[]): number[] {
  let running = 0;
  return values.map((value) => (running += value));
}

/**
 * The trailing average over the last {@link AVERAGE_SPAN} periods, the current one included.
 *
 * Null until a full span exists: an "average" over the first two periods is a different statistic
 * wearing the same line, and a reader would compare it with the rest as though it were not.
 */
export function trailingAverage(values: readonly number[], span = AVERAGE_SPAN): (number | null)[] {
  return values.map((_, index) => {
    if (index + 1 < span) {
      return null;
    }
    let sum = 0;
    for (let offset = index + 1 - span; offset <= index; offset += 1) {
      sum += values[offset] ?? 0;
    }
    return sum / span;
  });
}

/** One drawn series: a label, its values per bucket, and how it is styled. */
export interface PlottedSeries {
  readonly key: string;
  readonly label: string;
  readonly values: readonly number[];
  readonly style: SeriesStyle;
}

/**
 * The series a chart draws, with the line transforms applied.
 *
 * An unsplit chart is one series named after what it measures, so every renderer draws series and
 * none has a second code path for "not split".
 */
export function plottedSeries(
  chart: ItemChart,
  labels: ChartLabels = RAW_LABELS,
  options: { readonly cumulative?: boolean } = {},
): PlottedSeries[] {
  const totals = chart.measure === 'sum';
  const transform = (values: number[]) =>
    options.cumulative === true ? cumulative(values) : values;

  if (chart.series.length === 0) {
    return [
      {
        key: 'all',
        label: totals ? labels.property(chart.measureProperty) || 'Total' : 'Items',
        values: transform(chart.buckets.map((bucket) => measureOf(bucket, totals))),
        style: seriesStyle(0, false),
      },
    ];
  }

  return chart.series.map((series, index) => ({
    key: series.other ? ' other' : (series.value ?? ' unset'),
    label: seriesLabel(series, chart.otherSeries, labels, chart.splitBy),
    values: transform(
      chart.buckets.map((bucket) => {
        const cell = bucket.cells[index];
        return cell === undefined ? 0 : measureOf(cell, totals);
      }),
    ),
    style: seriesStyle(index, series.other),
  }));
}

/**
 * How one series is told apart from the others.
 *
 * **Six series roles from the design tokens, and no more series than that.** The token sheet
 * carries `--color-series-1` to `-6`: muted hues (steel, ochre, teal, plum, moss, graphite), each at
 * least 3:1 against the ground and the surface on both themes, and at least 1.2:1 apart from one
 * another in lightness, which `theme.test.ts` computes and asserts. Core and this renderer both cap
 * a split at six named series; everything past them is one "Other" series in the muted tone.
 *
 * **Never by colour alone.** Each series also has its own pattern - a fill hatch for columns, areas
 * and slices, a dash for lines - and every series is named in the legend and in the table, which
 * carries every figure as text. The drawing is decoration over the table, never the only place a
 * value lives.
 */
export interface SeriesStyle {
  /** Classes for a filled mark's colour: a column segment, an area, a slice, a legend swatch. */
  readonly fill: string;
  /** Classes for a stroked mark: a line. */
  readonly stroke: string;
  /** The SVG dash pattern for a line, or undefined for a solid one. */
  readonly dash: string | undefined;
  /** Which hatch a fill carries over its colour; `none` for a solid fill. */
  readonly hatch: SeriesHatch;
}

export type SeriesHatch =
  'none' | 'diagonal' | 'dots' | 'cross' | 'horizontal' | 'vertical' | 'back';

const SERIES_ROLES: readonly { readonly fill: string; readonly stroke: string }[] = [
  { fill: 'fill-series-1 bg-series-1', stroke: 'stroke-series-1' },
  { fill: 'fill-series-2 bg-series-2', stroke: 'stroke-series-2' },
  { fill: 'fill-series-3 bg-series-3', stroke: 'stroke-series-3' },
  { fill: 'fill-series-4 bg-series-4', stroke: 'stroke-series-4' },
  { fill: 'fill-series-5 bg-series-5', stroke: 'stroke-series-5' },
  { fill: 'fill-series-6 bg-series-6', stroke: 'stroke-series-6' },
];

const SERIES_DASHES: readonly (string | undefined)[] = [
  undefined,
  '8 4',
  '2 4',
  '8 3 2 3',
  '4 4',
  '12 4',
];

const SERIES_HATCHES: readonly SeriesHatch[] = [
  'none',
  'diagonal',
  'dots',
  'cross',
  'horizontal',
  'vertical',
];

const OTHER_STYLE: SeriesStyle = {
  fill: 'fill-muted bg-muted',
  stroke: 'stroke-muted',
  dash: '1 4',
  hatch: 'back',
};

export function seriesStyle(index: number, other: boolean): SeriesStyle {
  if (other) {
    return OTHER_STYLE;
  }
  const position = index % SERIES_ROLES.length;
  const role = SERIES_ROLES[position] ?? { fill: '', stroke: '' };
  return {
    fill: role.fill,
    stroke: role.stroke,
    dash: SERIES_DASHES[position],
    hatch: SERIES_HATCHES[position] ?? 'none',
  };
}

/** What a chart shows, said once above the drawing: measure, grouping, split and window. */
export function chartCaption(chart: ItemChart, labels: ChartLabels = RAW_LABELS): string {
  const totals = chart.measure === 'sum';
  const what = totals ? `Total of ${labels.property(chart.measureProperty)}` : 'How many items';
  const by = isChartPeriod(chart.period)
    ? `per ${chart.period} of ${labels.property(chart.groupBy)}`
    : `by ${labels.property(chart.groupBy)}`;
  const split = chart.splitBy === null ? '' : `, split by ${labels.property(chart.splitBy)}`;
  const window =
    chart.from !== null && chart.to !== null
      ? `, ${formatDay(chart.from)} to ${formatDay(chart.to)}`
      : '';
  return `${what} ${by}${split}${window}`;
}

/** A bucket's key for React, stable across reloads. */
export function bucketKey(bucket: ChartBucket): string {
  return bucket.value ?? ' unset';
}
