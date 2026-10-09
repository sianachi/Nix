import type { ItemChart } from '@nix/api-client';
import { Button, Text, cn, focusRing } from '@nix/ui';
import type { ReactNode } from 'react';

import {
  EmptyPanel,
  ErrorPanel,
  LoadingPanel,
  PartialNotice,
} from '../../components/states/status-panels';
import { UNSET_LABEL, type PropertyDefinition } from '../core/container-model';
import type { ViewRendererProps } from '../core/view-kinds';
import {
  AVERAGE_SPAN,
  bucketKey,
  bucketLabel,
  CHART_PERIOD_LABELS,
  chartCaption,
  chartKindOf,
  chartLabels,
  countOf,
  formatDay,
  formatMeasure,
  isChartPeriod,
  MAXIMUM_SERIES,
  measureOf,
  plottedSeries,
  seriesStyle,
  trailingAverage,
  type ChartKind,
  type ChartLabels,
  type PlottedSeries,
} from './chart-model';
import { ChartTable, type ChartTableColumn } from './chart-table';
import { ChartLegend, ColumnChart, LineChart, PieChart, type PieSlice } from './svg-charts';
import { useChart } from './use-chart';
import { YearGrid } from './year-grid';

/**
 * The chart view: a container's children summarised into bars, columns, a pie, lines, areas or a
 * year grid.
 *
 * **The third kind whose data is not the loaded children.** Its buckets come from
 * `GET /items/{id}/chart`, computed over every child rather than over the page the container
 * happens to hold - a chart tallied in the browser from the first two hundred of three thousand
 * would be a picture of the first page presented as a picture of the whole. `container.children` is
 * deliberately ignored, and so is `useViewChrome`, whose filter and sort branches are statements
 * about children this view does not draw.
 *
 * **One source for every option.** The chart's type, period, split, window and line options are all
 * read from the server's payload - the stored configuration the buckets were computed from - never
 * mixed with the client's copy of the view, which may already be newer. A change to the stored view
 * changes its fingerprint, and the chart is read again.
 *
 * **Every type is a table that happens to be drawn.** The numbers are text in the markup and the
 * drawing is `aria-hidden` decoration over them, so a screen reader gets the figures rather than a
 * description of a picture, and a copy-paste gets data. Bars keep the oldest form of that rule - the
 * bar sits behind its own row - and every other type draws above a table of the same figures. The
 * year grid's days carry their sentences, with the full table behind a disclosure because a year of
 * days is a long table.
 *
 * **Unset is a bar, and undated and out-of-window are said.** A container half of whose children
 * have no status is mostly a container of unset things, and dropping that bucket would misreport
 * every proportion beside it. On a time axis an item with no date, or one outside the window, has
 * no period to sit in, so it is counted and the chart says how many rather than quietly shrinking.
 */
export function ChartView(props: ViewRendererProps): ReactNode {
  const { container, view } = props;
  const fields = container.schema?.properties ?? [];

  // What the stored configuration is, so a saved change is read again rather than left drawn.
  const fingerprint = JSON.stringify([
    view.groupBy,
    view.measure ?? null,
    view.measureProperty ?? null,
    view.chart ?? null,
  ]);
  const run = useChart(container.itemId ?? '', view.id, fingerprint);

  if (run.status === 'loading') {
    return <LoadingPanel label="this chart" />;
  }

  if (run.status === 'error' || run.chart === null) {
    // Retrying cannot finish a configuration or unlock an item, so only a failure that a second
    // attempt could fix offers one.
    const retryable = run.failure === 'unavailable' || run.failure === null;
    return (
      <ErrorPanel
        title="This chart could not be drawn"
        detail={run.error ?? 'The chart could not be read.'}
        action={
          retryable ? (
            <Button
              variant="secondary"
              onClick={() => {
                void run.reload();
              }}
            >
              Try again
            </Button>
          ) : undefined
        }
      />
    );
  }

  return <ChartBody chart={run.chart} fields={fields} />;
}

export interface ChartBodyProps {
  readonly chart: ItemChart;
  /** The container's property definitions, which name the keys and values the payload carries. */
  readonly fields?: readonly PropertyDefinition[] | undefined;
}

/**
 * A loaded chart, drawn as its type says. Separate from {@link ChartView} so stories and tests can
 * hand it a payload without a server.
 */
export function ChartBody({ chart, fields = [] }: ChartBodyProps): ReactNode {
  const labels = chartLabels(fields);
  const kind = chartKindOf(chart.chartKind);
  const timeAxis = isChartPeriod(chart.period);
  const caption = chartCaption(chart, labels);

  if (
    chart.buckets.length === 0 &&
    chart.children === 0 &&
    chart.unplaced === 0 &&
    chart.outsideWindow === 0
  ) {
    return (
      <EmptyPanel
        title="Nothing to summarise yet"
        detail={`This chart groups the items inside this one by "${labels.property(chart.groupBy)}". Add some and it fills in.`}
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Text as="h3" variant="h6">
        {caption}
      </Text>

      <Notices chart={chart} labels={labels} />

      {chart.buckets.length === 0 ? (
        <Text variant="bodySmall" tone="muted">
          {timeAxis && chart.from !== null && chart.to !== null
            ? `Nothing between ${formatDay(chart.from)} and ${formatDay(chart.to)}.`
            : timeAxis && chart.from !== null
              ? `Nothing since ${formatDay(chart.from)}.`
              : 'There is nothing to draw.'}
        </Text>
      ) : (
        <Drawing chart={chart} kind={kind} labels={labels} caption={caption} />
      )}

      <Text variant="note" tone="muted">
        {`${chart.measure === 'sum' ? 'Totalled' : 'Counted'} across ${chart.children === 1 ? 'the 1 item' : `all ${countOf(chart.children, 'item')}`} inside this one${timeAxis ? ' that fall in these periods' : ''}.`}
      </Text>
    </div>
  );
}

/** Everything the chart cannot show, said before it is drawn. */
function Notices({
  chart,
  labels,
}: {
  readonly chart: ItemChart;
  readonly labels: ChartLabels;
}): ReactNode {
  const timeAxis = isChartPeriod(chart.period);
  const notices: string[] = [];
  const groupBy = labels.property(chart.groupBy);

  if (chart.truncated) {
    notices.push(
      timeAxis
        ? chart.buckets.length === 0
          ? 'This chart has more entries than it can read at once, and the latest it read had no date.'
          : `This chart shows the latest ${String(chart.buckets.length)} of ${String(chart.distinctValues)} periods. Earlier ones are not drawn.`
        : `This chart shows the largest ${String(chart.buckets.length)} of ${String(chart.distinctValues)} groups. The rest are not drawn.`,
    );
  }
  if (chart.outsideWindow > 0) {
    notices.push(
      `${countOf(chart.outsideWindow, 'item')} ${chart.outsideWindow === 1 ? 'falls' : 'fall'} outside these dates.`,
    );
  }
  if (chart.unplaced > 0) {
    notices.push(
      `${countOf(chart.unplaced, 'item')} ${chart.unplaced === 1 ? 'has' : 'have'} no date in "${groupBy}" and ${chart.unplaced === 1 ? 'is' : 'are'} not on this chart.`,
    );
  }
  if (chart.otherSeries > 0) {
    notices.push(
      `Only the ${String(MAXIMUM_SERIES)} largest values of "${labels.property(chart.splitBy)}" have their own series; the other ${String(chart.otherSeries)} share one series, Other.`,
    );
  }

  return notices.map((notice) => <PartialNotice key={notice} pending={notice} />);
}

function Drawing({
  chart,
  kind,
  labels,
  caption,
}: {
  readonly chart: ItemChart;
  readonly kind: ChartKind;
  readonly labels: ChartLabels;
  readonly caption: string;
}): ReactNode {
  const lines = kind === 'line' || kind === 'area';
  const cumulative = lines && chart.cumulative;
  const split = chart.series.length > 0;
  const stacked = chart.stacked && split;
  const totals = chart.measure === 'sum';

  // A trailing average over a stack would sit on the wrong baseline, and one over fewer periods
  // than it spans is a different statistic; both are said rather than drawn.
  const averageAsked = lines && chart.rollingAverage;
  const averageStacked = averageAsked && kind === 'area' && stacked;
  const averageShort = averageAsked && chart.buckets.length < AVERAGE_SPAN;
  const averaged = averageAsked && !averageStacked && !averageShort;

  const rowHeader = isChartPeriod(chart.period)
    ? CHART_PERIOD_LABELS[chart.period]
    : labels.property(chart.groupBy);
  const rows = chart.buckets.map((bucket) => ({
    key: bucketKey(bucket),
    label: bucketLabel(bucket.value, chart.period, labels, chart.groupBy),
    muted: bucket.value === null,
  }));
  const axis = {
    labels: rows.map((row) => row.label),
    shortLabels: chart.buckets.map((bucket) =>
      bucketLabel(bucket.value, chart.period, labels, chart.groupBy, true),
    ),
    whole: !totals,
  };
  const series = plottedSeries(chart, labels, { cumulative });
  const averages = averaged ? series.map((entry) => trailingAverage(entry.values)) : undefined;

  const drawnLabel = (label: string) => (cumulative ? `${label} (running total)` : label);
  const columns: ChartTableColumn[] = [
    ...series.map((entry) => ({
      key: entry.key,
      label: drawnLabel(entry.label),
      values: entry.values,
    })),
    // The average is of what is drawn, so over a running total it is the running total's average,
    // and the header says so.
    ...(averages ?? []).map((values, index) => ({
      key: `average-${series[index]?.key ?? String(index)}`,
      label: `${drawnLabel(series[index]?.label ?? '')} (${String(AVERAGE_SPAN)}-period average)`,
      values,
    })),
    ...(split && !cumulative
      ? [
          {
            key: ' total',
            label: 'All',
            values: chart.buckets.map((bucket) => measureOf(bucket, totals)),
          },
        ]
      : []),
  ];

  const table = (
    <ChartTable
      caption={`${caption}: every figure`}
      rowHeader={rowHeader}
      rows={rows}
      columns={columns}
    />
  );

  switch (kind) {
    case 'bar':
      return (
        <BarTable
          chart={chart}
          caption={caption}
          rowHeader={rowHeader}
          rows={rows}
          series={series}
        />
      );

    case 'column':
      return (
        <div className="flex flex-col gap-3">
          {split ? <ChartLegend entries={series} lines={false} /> : null}
          <ColumnChart series={series} stacked={stacked} {...axis} />
          {table}
        </div>
      );

    case 'line':
    case 'area':
      return (
        <div className="flex flex-col gap-3">
          {split || averages !== undefined ? (
            <ChartLegend
              lines={kind === 'line'}
              entries={[
                ...series,
                ...(averages === undefined
                  ? []
                  : [
                      {
                        key: ' average',
                        label: `Dotted lines: each series' ${String(AVERAGE_SPAN)}-period average`,
                        style: seriesStyle(0, true),
                        dotted: true,
                      },
                    ]),
              ]}
            />
          ) : null}
          {averageStacked ? (
            <Text variant="note" tone="muted">
              {`The ${String(AVERAGE_SPAN)}-period average is not drawn on stacked areas, where it would sit on the wrong baseline.`}
            </Text>
          ) : null}
          {averageShort ? (
            <Text variant="note" tone="muted">
              {`The ${String(AVERAGE_SPAN)}-period average needs at least ${String(AVERAGE_SPAN)} periods; this chart has ${String(chart.buckets.length)}.`}
            </Text>
          ) : null}
          <LineChart
            series={series}
            area={kind === 'area'}
            stacked={stacked}
            averages={averages}
            {...axis}
          />
          {table}
        </div>
      );

    case 'pie':
      return <PieWithTable chart={chart} labels={labels} caption={caption} rowHeader={rowHeader} />;

    case 'year': {
      const unit = totals ? labels.property(chart.measureProperty) || 'total' : 'items';
      const cells = chart.buckets.map((bucket) => {
        const value = measureOf(bucket, totals);
        return {
          date: bucket.value ?? '',
          value,
          label: `${bucketLabel(bucket.value, 'day')}: ${totals ? `${formatMeasure(value)} ${unit}` : countOf(value, 'item')}`,
        };
      });
      return (
        <div className="flex flex-col gap-3">
          <YearGrid cells={cells} label={caption} unit={unit} />
          <details>
            <summary
              className={cn(
                'cursor-pointer rounded-sm py-1 any-pointer-coarse:min-h-(--control-lg)',
                focusRing,
              )}
            >
              <Text as="span" variant="bodySmall">
                Every day as a table
              </Text>
            </summary>
            {table}
          </details>
        </div>
      );
    }
  }
}

/**
 * A pie, its slices largest first, with every slice past the series cap drawn as one Other slice.
 * The table under it lists every bucket by name, folded or not.
 */
function PieWithTable({
  chart,
  labels,
  caption,
  rowHeader,
}: {
  readonly chart: ItemChart;
  readonly labels: ChartLabels;
  readonly caption: string;
  readonly rowHeader: string;
}): ReactNode {
  const totals = chart.measure === 'sum';
  const ranked = chart.buckets
    .map((bucket) => ({
      key: bucketKey(bucket),
      label: bucketLabel(bucket.value, chart.period, labels, chart.groupBy),
      value: measureOf(bucket, totals),
      muted: bucket.value === null,
    }))
    .sort((first, second) => second.value - first.value);
  const named = ranked.slice(0, MAXIMUM_SERIES);
  const folded = ranked.slice(MAXIMUM_SERIES);
  const slices: PieSlice[] = [
    ...named.map((slice, index) => ({ ...slice, style: seriesStyle(index, false) })),
    ...(folded.length === 0
      ? []
      : [
          {
            key: ' other',
            label: `Other (${countOf(folded.length, 'value')})`,
            value: folded.reduce((sum, slice) => sum + slice.value, 0),
            style: seriesStyle(MAXIMUM_SERIES, true),
          },
        ]),
  ];
  const whole = ranked.reduce((sum, slice) => sum + Math.max(0, slice.value), 0);

  return (
    <div className="flex flex-col gap-3">
      <PieChart slices={slices} />
      <ChartLegend entries={slices} lines={false} />
      <ChartTable
        caption={`${caption}: every figure`}
        rowHeader={rowHeader}
        rows={ranked}
        columns={[
          {
            key: 'value',
            label: totals ? labels.property(chart.measureProperty) || 'Total' : 'Items',
            values: ranked.map((slice) => slice.value),
          },
          {
            key: 'share',
            label: 'Share (%)',
            values: ranked.map((slice) =>
              whole === 0 ? 0 : Math.round((Math.max(0, slice.value) / whole) * 10000) / 100,
            ),
          },
        ]}
      />
    </div>
  );
}

/**
 * Horizontal bars: the table itself, with each row's bar drawn behind its label.
 *
 * The bar sits behind the label rather than in a column of its own: it is the same information drawn
 * twice, and a second column would make a reader check which one to believe. Split into series, the
 * bar is stacked from the series' segments at a quarter strength, so a label over it keeps its full
 * contrast, and each series gets its own column of figures. Labels are always in the default tone;
 * an unset bucket says so in words.
 */
function BarTable({
  chart,
  caption,
  rowHeader,
  rows,
  series,
}: {
  readonly chart: ItemChart;
  readonly caption: string;
  readonly rowHeader: string;
  readonly rows: readonly { readonly key: string; readonly label: string }[];
  readonly series: readonly PlottedSeries[];
}): ReactNode {
  const totals = chart.measure === 'sum';
  const split = chart.series.length > 0;
  const largest = chart.buckets.reduce(
    (most, bucket) => Math.max(most, measureOf(bucket, totals)),
    0,
  );

  return (
    <div className="flex flex-col gap-3">
      {split ? <ChartLegend entries={series} lines={false} /> : null}
      <div
        role="region"
        aria-label={caption}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Justification: a scrollable region needs a tab stop or its content cannot be scrolled without a pointer.
        tabIndex={0}
        className={cn('min-w-0 max-w-full overflow-x-auto rounded-sm', focusRing)}
      >
        <table className="w-full border-collapse">
          <caption className="sr-only">{caption}</caption>

          <thead>
            <tr>
              <th scope="col" className="p-1 text-left font-normal">
                <Text variant="note" tone="muted" as="span">
                  {rowHeader}
                </Text>
              </th>
              {split
                ? series.map((entry) => (
                    <th key={entry.key} scope="col" className="p-1 text-right font-normal">
                      <Text variant="note" tone="muted" as="span" className="whitespace-nowrap">
                        {entry.label}
                      </Text>
                    </th>
                  ))
                : null}
              <th scope="col" className="p-1 text-right font-normal">
                <Text variant="note" tone="muted" as="span">
                  {split ? 'All' : series[0]?.label}
                </Text>
              </th>
            </tr>
          </thead>

          <tbody>
            {chart.buckets.map((bucket, index) => {
              const measured = measureOf(bucket, totals);
              const label = rows[index]?.label ?? '';
              return (
                <tr key={bucketKey(bucket)} className="border-b border-divider">
                  <th scope="row" className="w-full p-1 text-left font-normal">
                    <span className="relative block">
                      <span aria-hidden="true" className="absolute inset-y-0 left-0 flex w-full">
                        {split ? (
                          series.map((entry) => (
                            <span
                              key={entry.key}
                              className={cn(
                                'h-full opacity-25 first:rounded-l-sm',
                                entry.style.fill,
                              )}
                              style={{ width: share(entry.values[index] ?? 0, largest) }} // design-token-exempt: a segment's length is the datum - this series' share of the largest bar - not a dimension anybody chose.
                            />
                          ))
                        ) : (
                          <span
                            className="h-full rounded-sm bg-accent/18"
                            style={{ width: share(measured, largest) }} // design-token-exempt: a bar's length is the datum - this bucket's share of the largest - not a dimension anybody chose, and no step on any scale could express it. The same case as a pane's share.
                          />
                        )}
                      </span>
                      <Text as="span" variant="bodySmall" className="relative px-2 py-1">
                        {bucket.value === null ? `${UNSET_LABEL} (no value)` : label}
                      </Text>
                    </span>
                  </th>

                  {split
                    ? series.map((entry) => (
                        <td key={entry.key} className="whitespace-nowrap p-1 text-right">
                          <Text as="span" variant="bodySmall">
                            {formatMeasure(entry.values[index] ?? 0)}
                          </Text>
                        </td>
                      ))
                    : null}

                  <td className="whitespace-nowrap p-1 text-right">
                    <Text as="span" variant="bodySmall">
                      {formatMeasure(measured)}
                    </Text>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function share(value: number, largest: number): string {
  return `${String(largest <= 0 ? 0 : (Math.max(0, value) / largest) * 100)}%`;
}
