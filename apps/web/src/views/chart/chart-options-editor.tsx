import { Checkbox, Field, Input, Select, Text } from '@nix/ui';
import type { ReactNode } from 'react';

import type { ChartOptions, PropertyDefinition, View } from '../core/container-model';
import {
  AVERAGE_SPAN,
  CHART_KIND_LABELS,
  CHART_PERIOD_LABELS,
  CHART_PERIODS,
  chartKindOf,
  MAXIMUM_CHART_PERIODS,
  type ChartKind,
} from './chart-model';
import {
  EMPTY_CHART_OPTIONS,
  groupsByDate,
  normalizeChartView,
  offeredChartKinds,
} from './chart-options';

export interface ChartOptionsEditorProps {
  readonly view: View;
  readonly fields: readonly PropertyDefinition[];
  readonly onChange: (view: View) => void;
}

type WindowShape = 'all' | 'last' | 'range';

/**
 * The chart view's own settings: its type, time axis, series and window.
 *
 * Shown only for what the chosen grouping can use - a period only for a date, line and area and the
 * year grid only along one, a window only once there is a period - and every change goes through
 * {@link normalizeChartView}, so what is saved is always something Core stores and the chart draws
 * as the editor showed it.
 */
export function ChartOptionsEditor({ view, fields, onChange }: ChartOptionsEditorProps): ReactNode {
  const options = view.chart ?? EMPTY_CHART_OPTIONS;
  const dated = groupsByDate(view, fields);
  const kind: ChartKind = chartKindOf(options.kind);
  const windowShape: WindowShape =
    options.lastPeriods !== null
      ? 'last'
      : options.from !== null || options.to !== null
        ? 'range'
        : 'all';
  const splittable = fields.filter((field) => field.type === 'select' || field.type === 'checkbox');

  const change = (patch: Partial<ChartOptions>) => {
    onChange(normalizeChartView({ ...view, chart: { ...options, ...patch } }, fields));
  };

  return (
    <div className="flex flex-col gap-3">
      <Field
        label="Chart type"
        hint={
          dated
            ? 'Bars, columns and a pie compare periods; a line or an area shows the trend; a year grid shades every day.'
            : 'Group by a date to draw a line, an area or a year grid.'
        }
      >
        {(control) => (
          <Select
            {...control}
            value={kind}
            onChange={(event) => {
              change({ kind: event.target.value });
            }}
          >
            {offeredChartKinds(dated).map((value) => (
              <option key={value} value={value}>
                {CHART_KIND_LABELS[value]}
              </option>
            ))}
          </Select>
        )}
      </Field>

      {dated && kind !== 'year' ? (
        <Field label="Count per" hint="Each bar or point is one of these. Weeks start on Monday.">
          {(control) => (
            <Select
              {...control}
              value={options.period ?? 'month'}
              onChange={(event) => {
                change({ period: event.target.value });
              }}
            >
              {CHART_PERIODS.map((value) => (
                <option key={value} value={value}>
                  {CHART_PERIOD_LABELS[value]}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : null}

      {dated ? (
        <Field
          label="Show"
          hint={
            kind === 'year'
              ? 'A year grid shows the last 53 weeks unless you choose dates.'
              : 'Periods with nothing in them are drawn as zero.'
          }
        >
          {(control) => (
            <Select
              {...control}
              value={windowShape}
              onChange={(event) => {
                const shape = event.target.value as WindowShape;
                change(
                  shape === 'last'
                    ? { lastPeriods: 12, from: null, to: null }
                    : shape === 'range'
                      ? {
                          lastPeriods: null,
                          from: options.from ?? today(-365),
                          to: options.to ?? today(0),
                        }
                      : { lastPeriods: null, from: null, to: null },
                );
              }}
            >
              <option value="all">
                {kind === 'year' ? 'The last 53 weeks' : 'Every period with items'}
              </option>
              <option value="last">The most recent periods</option>
              <option value="range">Between two dates</option>
            </Select>
          )}
        </Field>
      ) : null}

      {dated && windowShape === 'last' ? (
        <Field
          label="How many periods"
          hint={`Including the current one. At most ${String(MAXIMUM_CHART_PERIODS)}.`}
        >
          {(control) => (
            <Input
              {...control}
              type="number"
              min={1}
              max={MAXIMUM_CHART_PERIODS}
              value={options.lastPeriods ?? 12}
              onChange={(event) => {
                const count = Math.round(Number(event.target.value));
                if (Number.isFinite(count) && count >= 1 && count <= MAXIMUM_CHART_PERIODS) {
                  change({ lastPeriods: count });
                }
              }}
            />
          )}
        </Field>
      ) : null}

      {dated && windowShape === 'range' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="From" hint="Counted from the start of its period.">
            {(control) => (
              <Input
                {...control}
                type="date"
                value={options.from ?? ''}
                max={options.to ?? undefined}
                onChange={(event) => {
                  change({ from: event.target.value === '' ? null : event.target.value });
                }}
              />
            )}
          </Field>
          <Field label="To" hint="Counted to the end of its period.">
            {(control) => (
              <Input
                {...control}
                type="date"
                value={options.to ?? ''}
                min={options.from ?? undefined}
                onChange={(event) => {
                  change({ to: event.target.value === '' ? null : event.target.value });
                }}
              />
            )}
          </Field>
        </div>
      ) : null}

      {kind !== 'pie' && kind !== 'year' ? (
        <Field
          label="Split by"
          hint={
            splittable.length === 0
              ? 'There is no select or checkbox property to split by.'
              : 'Each value becomes its own series. The 12 largest are drawn; the rest share one.'
          }
        >
          {(control) => (
            <Select
              {...control}
              value={options.splitBy ?? ''}
              onChange={(event) => {
                change({ splitBy: event.target.value === '' ? null : event.target.value });
              }}
            >
              <option value="">None</option>
              {splittable
                .filter((field) => field.key !== view.groupBy)
                .map((field) => (
                  <option key={field.key} value={field.key}>
                    {field.label}
                  </option>
                ))}
            </Select>
          )}
        </Field>
      ) : null}

      {kind === 'line' || kind === 'area' ? (
        <fieldset className="flex flex-col gap-2">
          <legend>
            <Text as="span" variant="note" tone="muted">
              Lines
            </Text>
          </legend>
          <Checkbox
            label="Running total"
            checked={options.cumulative === true}
            onChange={(event) => {
              change({ cumulative: event.target.checked ? true : null });
            }}
          />
          <Checkbox
            label={`${String(AVERAGE_SPAN)}-period average`}
            checked={options.rollingAverage === true}
            onChange={(event) => {
              change({ rollingAverage: event.target.checked ? true : null });
            }}
          />
        </fieldset>
      ) : null}
    </div>
  );
}

/** Today shifted by a number of days, as `yyyy-MM-dd` in the reader's own calendar. */
function today(offset: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
