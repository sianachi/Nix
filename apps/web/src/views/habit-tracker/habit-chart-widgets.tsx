import { Button, Text } from '@nix/ui';
import type { HabitTracker } from '@nix/api-client';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ErrorPanel, LoadingPanel } from '../../components/states/status-panels';
import { useHabits } from './use-habits';

export type HabitWidgetKind = 'completion' | 'quantity' | 'heatmap';

export interface HabitWidgetConfig {
  readonly id: string;
  readonly kind: HabitWidgetKind;
  readonly habitId: string;
  readonly from: string;
  readonly to: string;
}

export interface HabitChartWidgetsProps {
  readonly widgets: readonly HabitWidgetConfig[] | undefined;
  readonly trackers: ReadonlyMap<string, HabitTracker>;
  readonly availableHabits: readonly { readonly id: string; readonly title: string }[];
  readonly onChange: (widgets: readonly HabitWidgetConfig[]) => void;
}

const labels: Record<HabitWidgetKind, string> = {
  completion: 'Completion',
  quantity: 'Quantity',
  heatmap: 'Activity heatmap',
};

/** Embedded habit progress charts. Configuration is controlled so the parent can persist it with its view. */
export function HabitChartWidgets({
  widgets,
  trackers,
  availableHabits,
  onChange,
}: HabitChartWidgetsProps): ReactNode {
  widgets ??= [];
  const [kind, setKind] = useState<HabitWidgetKind>('completion');
  const [habitId, setHabitId] = useState(availableHabits[0]?.id ?? '');
  const [range, setRange] = useState(30);
  const selectedHabitId = availableHabits.some((habit) => habit.id === habitId)
    ? habitId
    : (availableHabits[0]?.id ?? '');
  const add = () => {
    if (selectedHabitId === '') return;
    const timezone = trackers.get(selectedHabitId)?.timezone ?? 'UTC';
    const to = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const fromDate = new Date(`${to}T00:00:00Z`);
    fromDate.setUTCDate(fromDate.getUTCDate() - range + 1);
    const from = fromDate.toISOString().slice(0, 10);
    if (range < 1 || range > 366 || widgets.length >= 12) return;
    onChange([...widgets, { id: crypto.randomUUID(), kind, habitId: selectedHabitId, from, to }]);
  };
  const remove = (id: string) => {
    onChange(widgets.filter((widget) => widget.id !== id));
  };
  const move = (index: number, direction: -1 | 1) => {
    const next = index + direction;
    if (next < 0 || next >= widgets.length) return;
    const copy = [...widgets];
    const current = copy[index];
    const replacement = copy[next];
    if (current === undefined || replacement === undefined) return;
    copy[index] = replacement;
    copy[next] = current;
    onChange(copy);
  };
  const update = (id: string, changes: Partial<HabitWidgetConfig>) => {
    const next = widgets.map((widget) => (widget.id === id ? { ...widget, ...changes } : widget));
    const changed = next.find((widget) => widget.id === id);
    if (changed !== undefined && validRange(changed.from, changed.to)) onChange(next);
  };

  return (
    <section className="flex flex-col gap-3" aria-labelledby="habit-chart-widgets-title">
      <Text as="h3" variant="h3" id="habit-chart-widgets-title">
        Progress charts
      </Text>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <Text variant="note" tone="muted" as="span">
            Chart
          </Text>
          <select
            className="rounded-md border border-divider bg-surface px-2 py-1"
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as HabitWidgetKind);
            }}
          >
            {Object.entries(labels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <Text variant="note" tone="muted" as="span">
            Habit
          </Text>
          <select
            className="rounded-md border border-divider bg-surface px-2 py-1"
            value={selectedHabitId}
            onChange={(event) => {
              setHabitId(event.target.value);
            }}
          >
            {availableHabits.map((habit) => (
              <option key={habit.id} value={habit.id}>
                {habit.title}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <Text variant="note" tone="muted" as="span">
            Days
          </Text>
          <select
            className="rounded-md border border-divider bg-surface px-2 py-1"
            value={range}
            onChange={(event) => {
              setRange(Number(event.target.value));
            }}
          >
            {[7, 30, 90].map((days) => (
              <option key={days} value={days}>
                {days}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="secondary"
          onClick={add}
          disabled={selectedHabitId === '' || widgets.length >= 12}
        >
          Add chart
        </Button>
      </div>
      {widgets.length === 0 ? (
        <Text variant="bodySmall" tone="muted">
          Add a chart to see progress over time.
        </Text>
      ) : null}
      {widgets.map((widget, index) => {
        const tracker = trackers.get(widget.habitId);
        return (
          <article key={widget.id} className="rounded-md border border-divider p-3">
            <header className="flex items-center justify-between gap-2">
              <Text as="h4" variant="body" className="font-medium">
                {labels[widget.kind]}
              </Text>
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  disabled={index === 0}
                  onClick={() => {
                    move(index, -1);
                  }}
                  aria-label="Move chart up"
                >
                  Up
                </Button>
                <Button
                  variant="ghost"
                  disabled={index === widgets.length - 1}
                  onClick={() => {
                    move(index, 1);
                  }}
                  aria-label="Move chart down"
                >
                  Down
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    remove(widget.id);
                  }}
                >
                  Remove
                </Button>
              </div>
            </header>
            <div className="flex flex-wrap items-end gap-2 py-2">
              <label className="flex flex-col gap-1">
                <Text variant="note" tone="muted" as="span">
                  Chart
                </Text>
                <select
                  className="rounded-md border border-divider bg-surface px-2 py-1"
                  value={widget.kind}
                  onChange={(event) => {
                    update(widget.id, { kind: event.target.value as HabitWidgetKind });
                  }}
                >
                  {Object.entries(labels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <Text variant="note" tone="muted" as="span">
                  Habit
                </Text>
                <select
                  className="rounded-md border border-divider bg-surface px-2 py-1"
                  value={widget.habitId}
                  onChange={(event) => {
                    update(widget.id, { habitId: event.target.value });
                  }}
                >
                  {availableHabits.map((habit) => (
                    <option key={habit.id} value={habit.id}>
                      {habit.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <Text variant="note" tone="muted" as="span">
                  From
                </Text>
                <input
                  className="rounded-md border border-divider bg-surface px-2 py-1"
                  type="date"
                  value={widget.from}
                  onChange={(event) => {
                    update(widget.id, { from: event.target.value });
                  }}
                />
              </label>
              <label className="flex flex-col gap-1">
                <Text variant="note" tone="muted" as="span">
                  To
                </Text>
                <input
                  className="rounded-md border border-divider bg-surface px-2 py-1"
                  type="date"
                  value={widget.to}
                  onChange={(event) => {
                    update(widget.id, { to: event.target.value });
                  }}
                />
              </label>
            </div>
            <WidgetData widget={widget} refreshKey={tracker} />
          </article>
        );
      })}
    </section>
  );
}

function WidgetData({
  widget,
  refreshKey,
}: {
  readonly widget: HabitWidgetConfig;
  readonly refreshKey: HabitTracker | undefined;
}): ReactNode {
  // Stable identity keeps unrelated editor changes from restarting this range query.
  const ids = useMemo(() => [widget.habitId], [widget.habitId]);
  const state = useHabits(ids, widget.from, widget.to);
  const { reload } = state;
  useEffect(() => {
    if (refreshKey !== undefined) reload();
    // The parent tracker identity changes after a successful check-in/settings mutation. The
    // widget owns a separate range query, so explicitly revalidate it at that boundary.
  }, [refreshKey, reload]);
  if (state.status === 'loading') return <LoadingPanel label="chart data" />;
  if (state.status === 'error') {
    return (
      <ErrorPanel
        title="Chart data could not be loaded"
        detail={state.error ?? 'Try again to reload this chart.'}
        action={
          <Button variant="secondary" onClick={state.reload}>
            Try again
          </Button>
        }
      />
    );
  }
  const tracker = state.trackers.get(widget.habitId);
  return tracker === undefined ? (
    <Text variant="bodySmall" tone="muted">
      This habit is unavailable for the selected range.
    </Text>
  ) : (
    <Chart widget={widget} tracker={tracker} />
  );
}

function Chart({
  widget,
  tracker,
}: {
  readonly widget: HabitWidgetConfig;
  readonly tracker: HabitTracker;
}): ReactNode {
  if (widget.kind === 'heatmap') {
    const byDay = new Map((tracker.occurrences ?? []).map((entry) => [entry.date, entry]));
    const days = dateRange(widget.from, widget.to);
    const offset = (new Date(`${widget.from}T00:00:00Z`).getUTCDay() + 6) % 7;
    return (
      <div className="flex flex-col gap-2">
        <div className="grid grid-cols-7 gap-1" aria-label="Habit activity heatmap">
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => (
            <Text key={day} variant="caption" className="text-center">
              {day}
            </Text>
          ))}
          {Array.from({ length: offset }, (_, index) => (
            <span key={`padding-${String(index)}`} aria-hidden="true" />
          ))}
          {days.map((day) => {
            const occurrence = byDay.get(day);
            const state = occurrence?.state ?? 'unavailable';
            return (
              <span
                key={day}
                role="img"
                aria-label={`${day}: ${state}`}
                title={`${day}: ${state}`}
                className={`flex h-8 items-center justify-center rounded-sm ${
                  state === 'completed'
                    ? 'bg-accent-fill text-background'
                    : state === 'partial'
                      ? 'bg-accent/20'
                      : state === 'missed'
                        ? 'bg-divider'
                        : state === 'scheduled'
                          ? 'border border-divider bg-surface'
                          : 'bg-surface'
                }`}
              >
                <Text
                  as="span"
                  variant="caption"
                  className={state === 'completed' ? 'text-background' : ''}
                >
                  {day.slice(8)}
                </Text>
              </span>
            );
          })}
        </div>
        <Text variant="caption" tone="muted">
          Filled: completed. Light fill: partial. Grey: missed. Outline: scheduled. Faded: not
          scheduled.
        </Text>
      </div>
    );
  }
  const values =
    widget.kind === 'completion'
      ? tracker.weeks.map((week) => ({
          label: week.weekStart,
          value: week.planned === 0 ? 0 : (week.completed / week.planned) * 100,
        }))
      : (
          tracker.occurrences ??
          tracker.checkIns.map((checkIn) => ({
            date: checkIn.occurredOn,
            quantity: checkIn.quantity,
          }))
        ).map((occurrence) => ({
          label: occurrence.date,
          value: occurrence.quantity ?? 0,
        }));
  const maximum = Math.max(...values.map((value) => value.value), 1);
  const points =
    widget.kind === 'quantity' && values.length > 1
      ? values
          .map(
            (value, index) =>
              `${String((index / (values.length - 1)) * 100)},${String(100 - (value.value / maximum) * 100)}`,
          )
          .join(' ')
      : null;
  return (
    <div className="flex flex-col gap-1" aria-label={`${labels[widget.kind]} chart`}>
      {points === null ? null : (
        <svg
          aria-hidden="true"
          className="h-24 w-full"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          <polyline
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
            points={points}
          />
        </svg>
      )}
      {values.length === 0 ? (
        <Text variant="bodySmall" tone="muted">
          No data in this range.
        </Text>
      ) : null}
      {widget.kind === 'quantity' ? (
        <details>
          <summary>
            <Text as="span" variant="caption">
              Show daily values ({tracker.unit})
            </Text>
          </summary>
          {values.map((value) => (
            <div key={value.label} className="flex items-center gap-2">
              <Text variant="note" tone="muted" className="w-24">
                {value.label}
              </Text>
              <span aria-hidden="true" className="h-2 flex-1 rounded-sm bg-accent/20">
                <DataBar
                  value={value.value}
                  maximum={widget.kind === 'completion' ? 100 : maximum}
                />
              </span>
              <Text variant="note">
                {widget.kind === 'completion'
                  ? `${String(Math.round(value.value))}%`
                  : String(value.value)}
              </Text>
            </div>
          ))}
        </details>
      ) : (
        values.map((value) => (
          <div key={value.label} className="flex items-center gap-2">
            <Text variant="note" tone="muted" className="w-24">
              {value.label}
            </Text>
            <span aria-hidden="true" className="h-2 flex-1 rounded-sm bg-accent/20">
              <DataBar value={value.value} maximum={widget.kind === 'completion' ? 100 : maximum} />
            </span>
            <Text variant="note">
              {widget.kind === 'completion'
                ? `${String(Math.round(value.value))}%`
                : String(value.value)}
            </Text>
          </div>
        ))
      )}
    </div>
  );
}

function dateRange(from: string, to: string): readonly string[] {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  const days: string[] = [];
  for (const day = new Date(start); day <= end; day.setUTCDate(day.getUTCDate() + 1)) {
    days.push(day.toISOString().slice(0, 10));
  }
  return days;
}

function validRange(from: string, to: string): boolean {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return (
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    end >= start &&
    end - start <= 365 * 86_400_000
  );
}

function DataBar({
  value,
  maximum,
}: {
  readonly value: number;
  readonly maximum: number;
}): ReactNode {
  const width = `${String((value / maximum) * 100)}%`;
  return <span className="block h-2 rounded-sm bg-accent" style={{ width }} />; // design-token-exempt: width encodes the data percentage rather than a chosen design dimension.
}
