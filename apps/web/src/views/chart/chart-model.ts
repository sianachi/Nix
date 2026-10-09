import type { ChartBucket, ChartSeries, ItemChart } from '@nix/api-client';

import { UNSET_LABEL } from '../core/container-model';

/**
 * The pure arithmetic and vocabulary behind every chart type: what a bucket measures, what a period
 * is called, the derived lines, and how a series is told apart from its neighbours.
 *
 * Nothing here draws. Each renderer reads it, so a column chart and the table under it can never
 * disagree about a figure.
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

/** How many periods the trailing average spans. */
export const AVERAGE_SPAN = 7;

/** A type this build draws, or bars for one it does not know - what an older build owes a newer view. */
export function chartKindOf(value: string | null | undefined): ChartKind {
  return (CHART_KINDS as readonly string[]).includes(value ?? '') ? (value as ChartKind) : 'bar';
}

export function isChartPeriod(value: string | null | undefined): value is ChartPeriod {
  return (CHART_PERIODS as readonly string[]).includes(value ?? '');
}

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

/** A period's start date as the person reads it, or a category's value. */
export function bucketLabel(value: string | null, period: string | null): string {
  if (value === null) {
    return UNSET_LABEL;
  }
  if (!isChartPeriod(period)) {
    return value;
  }

  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  switch (period) {
    case 'day':
      return date.toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      });
    case 'week':
      return `Week of ${date.toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      })}`;
    case 'month':
      return date.toLocaleDateString(undefined, {
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      });
    case 'quarter':
      return `Q${String(Math.floor(date.getUTCMonth() / 3) + 1)} ${String(date.getUTCFullYear())}`;
    case 'year':
      return String(date.getUTCFullYear());
  }
}

/** What a series is called in a legend and a table header. */
export function seriesLabel(series: ChartSeries, otherValues: number): string {
  if (series.other) {
    return `Other (${String(otherValues)} ${otherValues === 1 ? 'value' : 'values'})`;
  }
  return series.value ?? UNSET_LABEL;
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
  options: { readonly cumulative?: boolean } = {},
): PlottedSeries[] {
  const totals = chart.measure === 'sum';
  const transform = (values: number[]) =>
    options.cumulative === true ? cumulative(values) : values;

  if (chart.series.length === 0) {
    return [
      {
        key: 'all',
        label: totals ? (chart.measureProperty ?? 'Total') : 'Items',
        values: transform(chart.buckets.map((bucket) => measureOf(bucket, totals))),
        style: seriesStyle(0, false),
      },
    ];
  }

  return chart.series.map((series, index) => ({
    key: series.other ? ' other' : (series.value ?? ' unset'),
    label: seriesLabel(series, chart.otherSeries),
    values: transform(
      chart.buckets.map((bucket) => {
        const cell = bucket.cells[index];
        return cell === undefined ? 0 : measureOf(cell, totals);
      }),
    ),
    style: seriesStyle(index, series.other),
  }));
}

/** The largest single value, and the largest stack, across a chart's series. */
export function extent(
  series: readonly PlottedSeries[],
  buckets: number,
): {
  readonly largest: number;
  readonly largestStack: number;
} {
  let largest = 0;
  let largestStack = 0;
  for (let index = 0; index < buckets; index += 1) {
    let stack = 0;
    for (const entry of series) {
      const value = entry.values[index] ?? 0;
      largest = Math.max(largest, value);
      stack += Math.max(0, value);
    }
    largestStack = Math.max(largestStack, stack);
  }
  return { largest, largestStack };
}

/**
 * How one series is told apart from the others.
 *
 * **There is no categorical palette in the design tokens, on purpose** - the system has one accent
 * and its ramps, and a chart is not a reason to invent twelve hues. So series are separated by
 * three things at once, none of which carries the meaning alone:
 *
 * 1. **Tone**: steps of the accent, secondary accent and neutral ramps, ordered so neighbouring
 *    series alternate between ramps and between light and dark steps. The first series uses the
 *    accent fill token, which flips with the theme; the rest are mid-ramp steps chosen because they
 *    sit away from both the light and the dark background.
 * 2. **Pattern**: lines cycle through solid, dashed and dotted strokes, so two series of similar
 *    tone still read apart, and in print and for colour-blind readers.
 * 3. **Labels**: every series is named in the legend and in the table, which carries every figure
 *    as text. The drawing is decoration over the table, never the only place a value lives.
 *
 * "Other" is always the neutral muted tone, so the folded remainder never looks like a value.
 */
export interface SeriesStyle {
  /** Classes for a filled mark: a column segment, an area, a pie slice, a legend swatch. */
  readonly fill: string;
  /** Classes for a stroked mark: a line. */
  readonly stroke: string;
  /** The SVG dash pattern for a line, or undefined for a solid one. */
  readonly dash: string | undefined;
}

const SERIES_TONES: readonly { readonly fill: string; readonly stroke: string }[] = [
  { fill: 'fill-accent-fill bg-accent-fill', stroke: 'stroke-accent-fill' },
  { fill: 'fill-accent-2-400 bg-accent-2-400', stroke: 'stroke-accent-2-400' },
  { fill: 'fill-neutral-600 bg-neutral-600', stroke: 'stroke-neutral-600' },
  { fill: 'fill-accent-400 bg-accent-400', stroke: 'stroke-accent-400' },
  { fill: 'fill-accent-2-600 bg-accent-2-600', stroke: 'stroke-accent-2-600' },
  { fill: 'fill-neutral-400 bg-neutral-400', stroke: 'stroke-neutral-400' },
  { fill: 'fill-accent-600 bg-accent-600', stroke: 'stroke-accent-600' },
  { fill: 'fill-accent-2-300 bg-accent-2-300', stroke: 'stroke-accent-2-300' },
  { fill: 'fill-neutral-500 bg-neutral-500', stroke: 'stroke-neutral-500' },
  { fill: 'fill-accent-300 bg-accent-300', stroke: 'stroke-accent-300' },
  { fill: 'fill-accent-2-700 bg-accent-2-700', stroke: 'stroke-accent-2-700' },
  { fill: 'fill-neutral-700 bg-neutral-700', stroke: 'stroke-neutral-700' },
];

/** Solid, dashed, dotted: cycled so neighbouring lines differ in pattern as well as tone. */
const SERIES_DASHES: readonly (string | undefined)[] = [undefined, '6 3', '2 3'];

const OTHER_STYLE: SeriesStyle = {
  fill: 'fill-muted/40 bg-muted/40',
  stroke: 'stroke-muted',
  dash: '1 4',
};

export function seriesStyle(index: number, other: boolean): SeriesStyle {
  if (other) {
    return OTHER_STYLE;
  }
  const tone = SERIES_TONES[index % SERIES_TONES.length] ?? SERIES_TONES[0];
  return {
    fill: tone?.fill ?? '',
    stroke: tone?.stroke ?? '',
    dash: SERIES_DASHES[index % SERIES_DASHES.length],
  };
}

/** A short caption for what a chart counts, said once above the drawing and in the table. */
export function chartCaption(chart: ItemChart): string {
  const totals = chart.measure === 'sum';
  const what = totals ? `Total of ${chart.measureProperty ?? ''}` : 'How many items';
  const by = isChartPeriod(chart.period)
    ? `per ${chart.period} of ${chart.groupBy}`
    : `by ${chart.groupBy}`;
  const split = chart.splitBy === null ? '' : `, split by ${chart.splitBy}`;
  return `${what} ${by}${split}`;
}

/** A bucket's key for React, stable across reloads. */
export function bucketKey(bucket: ChartBucket): string {
  return bucket.value ?? ' unset';
}
