import { cn, Text } from '@nix/ui';
import type { ReactNode } from 'react';

import { formatMeasure, type PlottedSeries, type SeriesStyle } from './chart-model';

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

/** One label per bucket on the horizontal axis, of which the frame shows the first, middle and last. */
export interface AxisLabels {
  readonly labels: readonly string[];
}

function Frame({
  maximum,
  labels,
  children,
}: {
  readonly maximum: number;
  readonly labels: readonly string[];
  readonly children: ReactNode;
}): ReactNode {
  const ticks =
    labels.length === 0 ? [] : [0, Math.floor((labels.length - 1) / 2), labels.length - 1];
  const shown = [...new Set(ticks)].map((index) => labels[index] ?? '');

  return (
    <div className="flex gap-2" aria-hidden="true">
      <div className="flex h-48 w-12 shrink-0 flex-col justify-between text-right">
        {[maximum, maximum / 2, 0].map((value, index) => (
          <Text key={index} variant="caption" tone="muted">
            {formatMeasure(Number(value.toFixed(2)))}
          </Text>
        ))}
      </div>
      <div className="min-w-0 flex-1">
        {children}
        <div className="mt-1 flex justify-between gap-2">
          {shown.map((label, index) => (
            <Text key={index} variant="caption" tone="muted" className="truncate">
              {label}
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

function positive(value: number | null | undefined): number {
  return value === null || value === undefined || value < 0 ? 0 : value;
}

export interface ColumnChartProps {
  readonly series: readonly PlottedSeries[];
  readonly labels: readonly string[];
  /** Stack the series in one column per bucket, or stand them side by side. */
  readonly stacked: boolean;
}

/** Vertical columns, one per bucket; stacked or side by side when the chart is split. */
export function ColumnChart({ series, labels, stacked }: ColumnChartProps): ReactNode {
  const count = labels.length;
  let maximum = 0;
  for (let index = 0; index < count; index += 1) {
    const values = series.map((entry) => positive(entry.values[index]));
    maximum = Math.max(
      maximum,
      stacked ? values.reduce((a, b) => a + b, 0) : Math.max(0, ...values),
    );
  }
  const scale = maximum === 0 ? 1 : maximum;
  const band = WIDTH / Math.max(1, count);
  const inner = band * 0.8;
  const height = (value: number) => (value / scale) * HEIGHT;

  return (
    <Frame maximum={maximum} labels={labels}>
      <svg
        viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
        preserveAspectRatio="none"
        className="h-48 w-full overflow-visible"
      >
        <Gridlines />
        {labels.map((label, index) => {
          const left = index * band + (band - inner) / 2;
          let base = HEIGHT;
          return (
            <g key={`${label}-${String(index)}`}>
              {series.map((entry, position) => {
                const value = positive(entry.values[index]);
                const tall = height(value);
                const sub = inner / Math.max(1, series.length);
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
                    width={stacked ? inner : sub}
                    height={tall}
                    className={cn(entry.style.fill, 'stroke-background')}
                    strokeWidth="1"
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

export interface LineChartProps {
  readonly series: readonly PlottedSeries[];
  readonly labels: readonly string[];
  /** Fill under each line; stacked when there is more than one series. */
  readonly area: boolean;
  /** Trailing averages to draw dashed over each series, aligned with `series`. */
  readonly averages?: readonly (readonly (number | null)[])[] | undefined;
}

/** One line per series along an ordered axis; areas stack when the chart is split. */
export function LineChart({ series, labels, area, averages }: LineChartProps): ReactNode {
  const count = labels.length;
  const stacked = area && series.length > 1;

  // For stacked areas each series sits on the ones before it; otherwise every line starts at zero.
  const bases: number[][] = [];
  const tops: number[][] = [];
  series.forEach((entry, position) => {
    const below = stacked && position > 0 ? (tops[position - 1] ?? []) : [];
    const base = Array.from({ length: count }, (_, index) => below[index] ?? 0);
    bases.push(base);
    tops.push(
      base.map(
        (floor, index) =>
          floor + (stacked ? positive(entry.values[index]) : (entry.values[index] ?? 0)),
      ),
    );
  });

  let maximum = 0;
  for (const row of tops) {
    for (const value of row) maximum = Math.max(maximum, value);
  }
  for (const row of averages ?? []) {
    for (const value of row) maximum = Math.max(maximum, value ?? 0);
  }
  const scale = maximum === 0 ? 1 : maximum;
  const x = (index: number) => (count < 2 ? WIDTH / 2 : (index / (count - 1)) * WIDTH);
  const y = (value: number) => HEIGHT - (Math.max(0, value) / scale) * HEIGHT;
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
    <Frame maximum={maximum} labels={labels}>
      <svg
        viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
        preserveAspectRatio="none"
        className="h-48 w-full overflow-visible"
      >
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
                  className={cn(entry.style.fill, 'opacity-60')}
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
              className={cn(entry.style.stroke, 'opacity-80')}
              strokeDasharray="1 3"
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
  const total = slices.reduce((sum, slice) => sum + positive(slice.value), 0);
  let angle = -Math.PI / 2;

  return (
    <svg viewBox="-1.05 -1.05 2.1 2.1" className="mx-auto size-48 max-w-full" aria-hidden="true">
      {total === 0 ? (
        <circle cx="0" cy="0" r="1" className="fill-divider" />
      ) : (
        slices.map((slice) => {
          const share = positive(slice.value) / total;
          if (share === 0) {
            return null;
          }
          const start = angle;
          angle += share * Math.PI * 2;
          const title = `${slice.label}: ${formatMeasure(slice.value)} (${String(Math.round(share * 100))}%)`;
          if (share >= 0.9999) {
            return (
              <circle key={slice.key} cx="0" cy="0" r="1" className={slice.style.fill}>
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
              className={cn(slice.style.fill, 'stroke-background')}
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

/** Which tone and pattern is which series. Text, so the legend is never only a colour. */
export function ChartLegend({
  entries,
  lines,
}: {
  readonly entries: readonly {
    readonly key: string;
    readonly label: string;
    readonly style: SeriesStyle;
  }[];
  /** Draw each sample as a line in its dash pattern rather than a filled swatch. */
  readonly lines: boolean;
}): ReactNode {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1" aria-label="Legend">
      {entries.map((entry) => (
        <li key={entry.key} className="flex items-center gap-2">
          {lines ? (
            <svg viewBox="0 0 24 6" className="h-2 w-6 shrink-0" aria-hidden="true">
              <line
                x1="0"
                x2="24"
                y1="3"
                y2="3"
                className={entry.style.stroke}
                strokeDasharray={entry.style.dash}
                strokeWidth="2"
              />
            </svg>
          ) : (
            <span
              className={cn('size-3 shrink-0 rounded-sm', entry.style.fill)}
              aria-hidden="true"
            />
          )}
          <Text as="span" variant="caption">
            {entry.label}
          </Text>
        </li>
      ))}
    </ul>
  );
}
