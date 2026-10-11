import type { SeriesHatch } from './model.js';

/**
 * Where every mark of a column, line, area or pie chart goes, in a fixed coordinate space.
 *
 * Shared by the web app's JSX charts and the site's SVG strings, so the two can never disagree
 * about a column's height or a slice's angle. Columns and lines draw in a {@link CHART_WIDTH} by
 * {@link CHART_HEIGHT} box; a pie draws in a unit circle centred on the origin.
 *
 * Negative totals are drawn from zero up as nothing: a sum can be negative, a column or a slice
 * cannot. The table beside every chart still carries the figure, signed.
 */

export const CHART_WIDTH = 600;
export const CHART_HEIGHT = 200;

/** Below this many units of width a column's background separator would swallow the column. */
const SEPARATOR_MINIMUM = 4;

export function positive(value: number | null | undefined): number {
  return value === null || value === undefined || value < 0 ? 0 : value;
}

/** A scale maximum a reader can tick: whole numbers for counts, rounded up to an even step. */
export function niceMaximum(value: number, whole: boolean): number {
  if (value <= 0) {
    return whole ? 2 : 1;
  }
  if (!whole) {
    return value;
  }
  const rounded = Math.ceil(value);
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

/** The pattern a series' fill is painted with, over its colour, in an 8 by 8 tile. */
export function hatchPath(hatch: SeriesHatch): string | null {
  switch (hatch) {
    case 'none':
      return null;
    case 'diagonal':
      return 'M0,8 L8,0';
    case 'back':
      return 'M0,0 L8,8';
    case 'cross':
      return 'M0,8 L8,0 M0,0 L8,8';
    case 'horizontal':
      return 'M0,4 L8,4';
    case 'vertical':
      return 'M4,0 L4,8';
    case 'dots':
      return 'M3,3 L3.01,3';
  }
}

/** The three scale ticks, top to bottom, as figures. */
export function scaleTicks(maximum: number, whole: boolean): number[] {
  return [maximum, maximum / 2, 0].map((value) =>
    whole ? Math.round(value) : Number(value.toFixed(2)),
  );
}

/** Which bucket labels an axis shows: first, middle and last. */
export function axisTickIndexes(count: number): number[] {
  return count === 0 ? [] : [...new Set([0, Math.floor((count - 1) / 2), count - 1])];
}

export interface ColumnRect {
  readonly bucket: number;
  readonly series: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ColumnGeometry {
  readonly maximum: number;
  /** Whether columns are wide enough to carry a ground-coloured separator. */
  readonly separated: boolean;
  readonly rects: readonly ColumnRect[];
}

/** Vertical columns, one band per bucket; stacked or side by side when split. */
export function columnGeometry(input: {
  readonly series: readonly { readonly values: readonly number[] }[];
  readonly count: number;
  readonly whole: boolean;
  readonly stacked: boolean;
}): ColumnGeometry {
  const { series, count, whole, stacked } = input;
  let largest = 0;
  for (let index = 0; index < count; index += 1) {
    const values = series.map((entry) => positive(entry.values[index]));
    largest = Math.max(
      largest,
      stacked ? values.reduce((a, b) => a + b, 0) : Math.max(0, ...values),
    );
  }
  const maximum = niceMaximum(largest, whole);
  const band = CHART_WIDTH / Math.max(1, count);
  const inner = band * 0.8;
  const sub = stacked ? inner : inner / Math.max(1, series.length);
  const height = (value: number) => (value / maximum) * CHART_HEIGHT;

  const rects: ColumnRect[] = [];
  for (let index = 0; index < count; index += 1) {
    const left = index * band + (band - inner) / 2;
    let base = CHART_HEIGHT;
    series.forEach((entry, position) => {
      const tall = height(positive(entry.values[index]));
      const x = stacked ? left : left + position * sub;
      const y = stacked ? base - tall : CHART_HEIGHT - tall;
      if (stacked) {
        base -= tall;
      }
      rects.push({ bucket: index, series: position, x, y, width: sub, height: tall });
    });
  }

  return { maximum, separated: sub >= SEPARATOR_MINIMUM, rects };
}

export interface LineGeometry {
  readonly maximum: number;
  /** Whether areas are stacked on one another. */
  readonly stacking: boolean;
  /** One path per series. */
  readonly lines: readonly string[];
  /** One polygon point list per series; empty unless areas were asked for. */
  readonly areas: readonly string[];
  /** One dotted path per averaged series. */
  readonly averages: readonly string[];
  /** Each drawn point, per series then bucket; empty past 60 buckets. */
  readonly points: readonly {
    readonly series: number;
    readonly bucket: number;
    readonly cx: number;
    readonly cy: number;
  }[];
}

/** One line per series along an ordered axis; areas stack when asked to. */
export function lineGeometry(input: {
  readonly series: readonly { readonly values: readonly number[] }[];
  readonly count: number;
  readonly whole: boolean;
  readonly area: boolean;
  readonly stacked: boolean;
  readonly averages?: readonly (readonly (number | null)[])[] | undefined;
}): LineGeometry {
  const { series, count, whole, area, stacked, averages } = input;
  const stacking = area && stacked && series.length > 1;

  // For stacked areas each series sits on the ones before it; otherwise every line starts at zero.
  const bases: number[][] = [];
  const tops: number[][] = [];
  series.forEach((entry, position) => {
    const below = stacking && position > 0 ? (tops[position - 1] ?? []) : [];
    const base = Array.from({ length: count }, (_, index) => below[index] ?? 0);
    bases.push(base);
    tops.push(
      base.map(
        (floor, index) =>
          floor + (stacking ? positive(entry.values[index]) : (entry.values[index] ?? 0)),
      ),
    );
  });

  let largest = 0;
  for (const row of tops) {
    for (const value of row) largest = Math.max(largest, value);
  }
  for (const row of averages ?? []) {
    for (const value of row) largest = Math.max(largest, value ?? 0);
  }
  const maximum = niceMaximum(largest, whole);
  const x = (index: number) => (count < 2 ? CHART_WIDTH / 2 : (index / (count - 1)) * CHART_WIDTH);
  const y = (value: number) => CHART_HEIGHT - (Math.max(0, value) / maximum) * CHART_HEIGHT;
  const line = (values: readonly (number | null)[]) => {
    let path = '';
    let connected = false;
    values.forEach((value, index) => {
      if (value === null) {
        connected = false;
        return;
      }
      path += `${connected ? ' L' : ' M'}${String(x(index))},${String(y(value))}`;
      connected = true;
    });
    return path.trim();
  };

  const areas = area
    ? series.map((_, position) => {
        const upper = (tops[position] ?? []).map(
          (value, index) => `${String(x(index))},${String(y(value))}`,
        );
        const lower = (bases[position] ?? [])
          .map((value, index) => `${String(x(index))},${String(y(value))}`)
          .reverse();
        return [...upper, ...lower].join(' ');
      })
    : [];

  const points =
    count <= 60
      ? series.flatMap((_, position) =>
          (tops[position] ?? []).map((value, index) => ({
            series: position,
            bucket: index,
            cx: x(index),
            cy: y(value),
          })),
        )
      : [];

  return {
    maximum,
    stacking,
    lines: series.map((_, position) => line(tops[position] ?? [])),
    areas,
    averages: (averages ?? []).map((values) => line(values)),
    points,
  };
}

export interface PieGeometry {
  readonly total: number;
  /** One per input value with a share; `d` is null for a slice that is the whole circle. */
  readonly slices: readonly {
    readonly index: number;
    readonly share: number;
    readonly d: string | null;
  }[];
}

/** Shares of the whole, clockwise from twelve o'clock in the order given, on a unit circle. */
export function pieGeometry(values: readonly number[]): PieGeometry {
  const total = values.reduce((sum, value) => sum + positive(value), 0);
  let angle = -Math.PI / 2;
  const slices: { index: number; share: number; d: string | null }[] = [];
  if (total === 0) {
    return { total, slices };
  }
  values.forEach((value, index) => {
    const share = positive(value) / total;
    if (share === 0) {
      return;
    }
    const start = angle;
    angle += share * Math.PI * 2;
    if (share >= 0.9999) {
      slices.push({ index, share, d: null });
      return;
    }
    const large = share > 0.5 ? 1 : 0;
    slices.push({
      index,
      share,
      d: `M0,0 L${String(Math.cos(start))},${String(Math.sin(start))} A1,1 0 ${String(large)} 1 ${String(Math.cos(angle))},${String(Math.sin(angle))} Z`,
    });
  });
  return { total, slices };
}
