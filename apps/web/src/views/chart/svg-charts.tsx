import { Text } from '@nix/ui';
import { useId, type ReactNode } from 'react';

import {
  formatMeasure,
  type PlottedSeries,
  type SeriesHatch,
  type SeriesStyle,
} from './chart-model';

/**
 * The drawn chart types: columns, lines and areas, and a pie.
 *
 * **Every drawing here is `aria-hidden` decoration over a table.** The figures are text in the
 * `ChartTable` the chart view renders beside each of these, which is what a screen reader reads and
 * what a copy carries. A hover `<title>` on each mark is a convenience for a pointer, not the only
 * place a value can be found.
 *
 * **Geometry in a fixed coordinate space, stretched to the container.** Each SVG draws in a 600 by
 * 200 box with `preserveAspectRatio="none"` and non-scaling strokes - the same approach the habit
 * trend takes - so it fills a phone or a wide pane without a resize observer. Axis labels are HTML
 * around the drawing, so text is never stretched with it. The pie keeps its aspect ratio; a
 * stretched circle would misstate every share.
 *
 * **Negative totals are drawn from zero up as nothing.** A sum can be negative; a column or a slice
 * cannot be. The table still carries the figure, signed.
 */

const WIDTH = 600;
const HEIGHT = 200;

/** Below this many units of width a column's background separator would swallow the column. */
const SEPARATOR_MINIMUM = 4;

function positive(value: number | null | undefined): number {
  return value === null || value === undefined || value < 0 ? 0 : value;
}

/** A scale maximum a reader can tick: whole numbers for counts, rounded up to an even step. */
function niceMaximum(value: number, whole: boolean): number {
  if (value <= 0) {
    return whole ? 2 : 1;
  }
  if (!whole) {
    return value;
  }
  const rounded = Math.ceil(value);
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

/** The pattern a series' fill is painted with: its colour, and a hatch in the ground's colour. */
function hatchPath(hatch: SeriesHatch): string | null {
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

/** One `<pattern>` per style, so fills are told apart by hatch as well as by tone. */
function SeriesPatterns({
  prefix,
  styles,
}: {
  readonly prefix: string;
  readonly styles: readonly SeriesStyle[];
}): ReactNode {
  return (
    <defs>
      {styles.map((style, index) => {
        const path = hatchPath(style.hatch);
        return (
          <pattern
            key={index}
            id={`${prefix}-${String(index)}`}
            patternUnits="userSpaceOnUse"
            width="8"
            height="8"
          >
            <rect width="8" height="8" className={style.fill} />
            {path === null ? null : (
              <path
                d={path}
                className="stroke-background"
                strokeWidth={style.hatch === 'dots' ? 3 : 1.5}
                strokeLinecap="round"
              />
            )}
          </pattern>
        );
      })}
    </defs>
  );
}

function patternFill(prefix: string, index: number): string {
  return `url(#${prefix}-${String(index)})`;
}

function Frame({
  maximum,
  whole,
  labels,
  shortLabels,
  children,
}: {
  readonly maximum: number;
  readonly whole: boolean;
  readonly labels: readonly string[];
  readonly shortLabels: readonly string[];
  readonly children: ReactNode;
}): ReactNode {
  const ticks =
    labels.length === 0 ? [] : [0, Math.floor((labels.length - 1) / 2), labels.length - 1];
  const shown = [...new Set(ticks)];

  return (
    <div className="flex gap-2" aria-hidden="true">
      <div className="flex h-48 w-10 shrink-0 flex-col justify-between text-right">
        {[maximum, maximum / 2, 0].map((value, index) => (
          <Text key={index} variant="caption" tone="muted">
            {formatMeasure(whole ? Math.round(value) : Number(value.toFixed(2)))}
          </Text>
        ))}
      </div>
      <div className="min-w-0 flex-1">
        {children}
        <div className="mt-1 flex justify-between gap-2">
          {shown.map((index) => (
            <Text key={index} variant="caption" tone="muted" className="truncate">
              <span className="hidden sm:inline">{labels[index] ?? ''}</span>
              <span className="sm:hidden">{shortLabels[index] ?? labels[index] ?? ''}</span>
            </Text>
          ))}
        </div>
      </div>
    </div>
  );
}

function Gridlines(): ReactNode {
  return (
    <>
      {[0, HEIGHT / 2, HEIGHT].map((y) => (
        <line
          key={y}
          x1="0"
          x2={WIDTH}
          y1={y}
          y2={y}
          className="stroke-divider"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </>
  );
}

export interface AxisProps {
  /** One label per bucket, of which the frame shows the first, middle and last. */
  readonly labels: readonly string[];
  /** The same labels shortened for a phone. */
  readonly shortLabels: readonly string[];
  /** Whether the values are counts, so the scale ticks whole numbers. */
  readonly whole: boolean;
}

export interface ColumnChartProps extends AxisProps {
  readonly series: readonly PlottedSeries[];
  /** Stack the series in one column per bucket, or stand them side by side. */
  readonly stacked: boolean;
}

/** Vertical columns, one per bucket; stacked or side by side when the chart is split. */
export function ColumnChart({
  series,
  labels,
  shortLabels,
  whole,
  stacked,
}: ColumnChartProps): ReactNode {
  const prefix = useId().replaceAll(':', '');
  const count = labels.length;
  let largest = 0;
  for (let index = 0; index < count; index += 1) {
    const values = series.map((entry) => positive(entry.values[index]));
    largest = Math.max(
      largest,
      stacked ? values.reduce((a, b) => a + b, 0) : Math.max(0, ...values),
    );
  }
  const maximum = niceMaximum(largest, whole);
  const band = WIDTH / Math.max(1, count);
  const inner = band * 0.8;
  const sub = stacked ? inner : inner / Math.max(1, series.length);
  const separated = sub >= SEPARATOR_MINIMUM;
  const height = (value: number) => (value / maximum) * HEIGHT;

  return (
    <Frame maximum={maximum} whole={whole} labels={labels} shortLabels={shortLabels}>
      <svg
        viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
        preserveAspectRatio="none"
        className="h-48 w-full overflow-visible"
      >
        <SeriesPatterns prefix={prefix} styles={series.map((entry) => entry.style)} />
        <Gridlines />
        {labels.map((label, index) => {
          const left = index * band + (band - inner) / 2;
          let base = HEIGHT;
          return (
            <g key={`${label}-${String(index)}`}>
              {series.map((entry, position) => {
                const value = positive(entry.values[index]);
                const tall = height(value);
                const x = stacked ? left : left + position * sub;
                const y = stacked ? base - tall : HEIGHT - tall;
                if (stacked) {
                  base -= tall;
                }
                return (
                  <rect
                    key={entry.key}
                    x={x}
                    y={y}
                    width={sub}
                    height={tall}
                    fill={patternFill(prefix, position)}
                    className={separated ? 'stroke-background' : undefined}
                    strokeWidth={separated ? 1 : 0}
                    vectorEffect="non-scaling-stroke"
                  >
                    <title>{`${label}, ${entry.label}: ${formatMeasure(entry.values[index] ?? 0)}`}</title>
                  </rect>
                );
              })}
            </g>
          );
        })}
      </svg>
    </Frame>
  );
}

export interface LineChartProps extends AxisProps {
  readonly series: readonly PlottedSeries[];
  /** Fill under each line. */
  readonly area: boolean;
  /** For areas split into series: stack them rather than overlaying them. */
  readonly stacked: boolean;
  /** Trailing averages to draw dotted over each series, aligned with `series`. Never stacked. */
  readonly averages?: readonly (readonly (number | null)[])[] | undefined;
}

/** One line per series along an ordered axis; areas stack when asked to. */
export function LineChart({
  series,
  labels,
  shortLabels,
  whole,
  area,
  stacked,
  averages,
}: LineChartProps): ReactNode {
  const prefix = useId().replaceAll(':', '');
  const count = labels.length;
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
  const x = (index: number) => (count < 2 ? WIDTH / 2 : (index / (count - 1)) * WIDTH);
  const y = (value: number) => HEIGHT - (Math.max(0, value) / maximum) * HEIGHT;
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

  return (
    <Frame maximum={maximum} whole={whole} labels={labels} shortLabels={shortLabels}>
      <svg
        viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
        preserveAspectRatio="none"
        className="h-48 w-full overflow-visible"
      >
        <SeriesPatterns prefix={prefix} styles={series.map((entry) => entry.style)} />
        <Gridlines />
        {area
          ? series.map((entry, position) => {
              const top = tops[position] ?? [];
              const base = bases[position] ?? [];
              const upper = top.map((value, index) => `${String(x(index))},${String(y(value))}`);
              const lower = base
                .map((value, index) => `${String(x(index))},${String(y(value))}`)
                .reverse();
              return (
                <polygon
                  key={`area-${entry.key}`}
                  points={[...upper, ...lower].join(' ')}
                  fill={patternFill(prefix, position)}
                  className={stacking ? undefined : 'opacity-50'}
                />
              );
            })
          : null}
        {series.map((entry, position) => (
          <path
            key={`line-${entry.key}`}
            d={line(tops[position] ?? [])}
            fill="none"
            className={entry.style.stroke}
            strokeDasharray={entry.style.dash}
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {(averages ?? []).map((values, position) => {
          const entry = series[position];
          return entry === undefined ? null : (
            <path
              key={`average-${entry.key}`}
              d={line(values)}
              fill="none"
              className={entry.style.stroke}
              strokeDasharray="0 6"
              strokeWidth="3"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
        {count <= 60
          ? series.map((entry, position) =>
              (tops[position] ?? []).map((value, index) => (
                <circle
                  key={`${entry.key}-${String(index)}`}
                  cx={x(index)}
                  cy={y(value)}
                  r="0.01"
                  fill="none"
                  className={entry.style.stroke}
                  strokeWidth="6"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                >
                  <title>{`${labels[index] ?? ''}, ${entry.label}: ${formatMeasure(entry.values[index] ?? 0)}`}</title>
                </circle>
              )),
            )
          : null}
      </svg>
    </Frame>
  );
}

export interface PieSlice {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly style: SeriesStyle;
}

/** Shares of the whole. Slices run clockwise from twelve o'clock in the order given. */
export function PieChart({ slices }: { readonly slices: readonly PieSlice[] }): ReactNode {
  const prefix = useId().replaceAll(':', '');
  const total = slices.reduce((sum, slice) => sum + positive(slice.value), 0);
  let angle = -Math.PI / 2;

  return (
    <svg viewBox="-1.05 -1.05 2.1 2.1" className="mx-auto size-48 max-w-full" aria-hidden="true">
      <SeriesPatterns prefix={prefix} styles={slices.map((slice) => slice.style)} />
      {total === 0 ? (
        <circle cx="0" cy="0" r="1" className="fill-divider" />
      ) : (
        slices.map((slice, index) => {
          const share = positive(slice.value) / total;
          if (share === 0) {
            return null;
          }
          const start = angle;
          angle += share * Math.PI * 2;
          const title = `${slice.label}: ${formatMeasure(slice.value)} (${String(Math.round(share * 100))}%)`;
          if (share >= 0.9999) {
            return (
              <circle key={slice.key} cx="0" cy="0" r="1" fill={patternFill(prefix, index)}>
                <title>{title}</title>
              </circle>
            );
          }
          const large = share > 0.5 ? 1 : 0;
          const d = `M0,0 L${String(Math.cos(start))},${String(Math.sin(start))} A1,1 0 ${String(large)} 1 ${String(Math.cos(angle))},${String(Math.sin(angle))} Z`;
          return (
            <path
              key={slice.key}
              d={d}
              fill={patternFill(prefix, index)}
              className="stroke-background"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            >
              <title>{title}</title>
            </path>
          );
        })
      )}
    </svg>
  );
}

/** One legend entry: a name and how its series is drawn. */
export interface LegendEntry {
  readonly key: string;
  readonly label: string;
  readonly style: SeriesStyle;
  /** Draw the sample as a dotted line in the muted tone, for the trailing average. */
  readonly dotted?: boolean;
}

/** Which tone and pattern is which series. Text, so the legend is never only a colour. */
export function ChartLegend({
  entries,
  lines,
}: {
  readonly entries: readonly LegendEntry[];
  /** Draw each sample as a line in its dash pattern rather than a filled, hatched swatch. */
  readonly lines: boolean;
}): ReactNode {
  const prefix = useId().replaceAll(':', '');
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1">
      {entries.map((entry, index) => (
        <li key={entry.key} className="flex min-w-0 max-w-full items-center gap-2">
          <svg
            viewBox={lines ? '0 0 24 8' : '0 0 12 12'}
            className={lines ? 'h-2 w-6 shrink-0' : 'size-3 shrink-0'}
            aria-hidden="true"
          >
            {lines || entry.dotted === true ? (
              <line
                x1="2"
                x2="22"
                y1="4"
                y2="4"
                className={entry.dotted === true ? 'stroke-muted' : entry.style.stroke}
                strokeDasharray={entry.dotted === true ? '0 6' : entry.style.dash}
                strokeWidth={entry.dotted === true ? 3 : 2}
                strokeLinecap="round"
              />
            ) : (
              <>
                <SeriesPatterns prefix={`${prefix}-${String(index)}`} styles={[entry.style]} />
                <rect
                  width="12"
                  height="12"
                  rx="2"
                  fill={patternFill(`${prefix}-${String(index)}`, 0)}
                />
              </>
            )}
          </svg>
          <Text as="span" variant="caption" className="min-w-0">
            {entry.label}
          </Text>
        </li>
      ))}
    </ul>
  );
}
