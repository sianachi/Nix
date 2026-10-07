import { Button, Checkbox, cn, Field, focusRing, Input, Select, Text } from '@nix/ui';
import { items } from '@nix/api-client';
import { Check, CheckCircle2, Circle, CircleAlert, Clock3 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ContainerData } from '../core/use-container';
import type { View } from '../core/container-model';
import {
  EmptyPanel,
  ErrorPanel,
  LoadingPanel,
  PartialNotice,
} from '../../components/states/status-panels';
import { useHabits } from './use-habits';
import type { HabitTracker, SetHabitInput } from '@nix/api-client';
import { useApiClient } from '../../api/api-client-provider';
import { useWorkspace } from '../../workspaces/workspace-context';
import { browserStorage } from '../../lib/browser-storage';
import { formatShortDate, localTimeZone } from '../../lib/date-format';
import { HabitChartWidgets, type HabitWidgetConfig } from './habit-chart-widgets';
import { HabitInsights } from './habit-insights';

export interface HabitTrackerViewProps {
  readonly container: ContainerData;
  readonly view: View;
  readonly onOpen: (itemId: string) => void;
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
function dateText(day: Date): string {
  return `${String(day.getFullYear())}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
}

export function todayInTimezone(timezone: string): string {
  return formatShortDate(new Date(), timezone);
}

function shiftedDay(day: string, offset: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function weekdayFor(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

const TODAY_ONLY_STORAGE_KEY = 'nix.habit-tracker.today-only';

/** The person's own Today/week choice, if they have made one. `null` means none was ever stored,
 * so a narrow screen's own default still applies. */
function readStoredTodayOnly(storage: Storage | undefined): boolean | null {
  try {
    const raw = storage?.getItem(TODAY_ONLY_STORAGE_KEY) ?? null;
    return raw === null ? null : raw === 'true';
  } catch {
    // Private browsing, or a policy that blocks storage. Falling back to the screen-width default
    // is a small loss; an application that will not start because of it is not.
    return null;
  }
}

function storeTodayOnly(storage: Storage | undefined, value: boolean): void {
  try {
    storage?.setItem(TODAY_ONLY_STORAGE_KEY, value ? 'true' : 'false');
  } catch {
    // Nothing to do and nothing worth failing over.
  }
}

export function weekWindow(offset = 0): { from: string; to: string; days: readonly string[] } {
  const now = new Date();
  const monday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - ((now.getDay() + 6) % 7) + offset * 7,
  );
  const days = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(monday);
    day.setDate(monday.getDate() + index);
    return dateText(day);
  });
  return { from: days[0] ?? dateText(monday), to: days[6] ?? dateText(monday), days };
}

export function HabitTrackerView({ container, view, onOpen }: HabitTrackerViewProps): ReactNode {
  const [weekOffset, setWeekOffset] = useState(0);
  const [todayOnlyChoice, setTodayOnlyChoice] = useState<boolean | null>(() =>
    readStoredTodayOnly(browserStorage()),
  );
  const todayOnly = todayOnlyChoice ?? true;
  const [screen, setScreen] = useState<'checkins' | 'insights'>('checkins');
  const chooseTodayOnly = useCallback((value: boolean) => {
    setScreen('checkins');
    setTodayOnlyChoice(value);
    storeTodayOnly(browserStorage(), value);
  }, []);
  const [, refreshClock] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      refreshClock((value) => value + 1);
    }, 60_000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  const window = weekWindow(weekOffset);
  const [showSetup, setShowSetup] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [widgets, setWidgets] = useState<readonly HabitWidgetConfig[]>(view.habitWidgets ?? []);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [widgetError, setWidgetError] = useState<string | null>(null);
  const [widgetsPending, setWidgetsPending] = useState(false);
  // Stable identity prevents unrelated input edits from reloading every habit.
  const ids = useMemo(() => container.children.map((item) => item.id), [container.children]);
  const state = useHabits(ids, shiftedDay(window.from, -1), shiftedDay(window.to, 1));
  const localDaySignature = ids
    .map((id) => `${id}:${todayInTimezone(state.trackers.get(id)?.timezone ?? 'UTC')}`)
    .join('|');
  const previousLocalDaySignature = useRef(localDaySignature);
  const observedLocalDays = useRef(false);
  useEffect(() => {
    if (!observedLocalDays.current) {
      if (state.status === 'loading' && state.trackers.size === 0) return;
      observedLocalDays.current = true;
      previousLocalDaySignature.current = localDaySignature;
      return;
    }
    if (previousLocalDaySignature.current !== localDaySignature) {
      previousLocalDaySignature.current = localDaySignature;
      state.reload();
    }
  }, [localDaySignature, state]);
  const client = useApiClient();
  const workspace = useWorkspace();
  const createdHabitId = useRef<string | null>(null);
  const refetchHabitEverywhere = useCallback(
    (habitId: string) => {
      return state.refetchHabit(habitId);
    },
    [state],
  );
  const saveCheckInAndRefresh = useCallback(
    async (
      habitId: string,
      day: string,
      completed: boolean,
      quantity: number | null,
    ): Promise<string | null> => {
      const refusal = await state.saveCheckIn(habitId, day, completed, quantity);
      if (refusal === null) await refetchHabitEverywhere(habitId);
      return refusal;
    },
    [state, refetchHabitEverywhere],
  );
  const undoCheckInAndRefresh = useCallback(
    async (habitId: string, day: string): Promise<string | null> => {
      const refusal = await state.undoCheckIn(habitId, day);
      if (refusal === null) await refetchHabitEverywhere(habitId);
      return refusal;
    },
    [state, refetchHabitEverywhere],
  );
  const habits = container.children.flatMap((item) => {
    const tracker = state.trackers.get(item.id);
    if (!showArchived && tracker?.status === 'archived') return [];
    return tracker === undefined ? [] : [{ ...item, tracker }];
  });

  const renderHabitDay = (habitId: string, day: string, tracker: HabitTracker): ReactNode => (
    <table className="block w-full border-collapse @lg:table" aria-label="Edit historical check-in">
      <tbody className="block @lg:table-row-group">
        <HabitRow
          key={`${habitId}:${day}`}
          itemId={habitId}
          title={habits.find((item) => item.id === habitId)?.title ?? 'Untitled habit'}
          days={[day]}
          tracker={tracker}
          onOpen={onOpen}
          onSave={saveCheckInAndRefresh}
          onUndo={undoCheckInAndRefresh}
          onEdit={() => {
            setEditingId(habitId);
          }}
          onStatus={state.setStatus}
        />
      </tbody>
    </table>
  );

  return (
    <section
      className="@container flex min-w-0 flex-col gap-6"
      aria-labelledby="habit-tracker-title"
    >
      <header className="flex flex-col gap-4 border-b border-divider pb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <Text as="h2" variant="h2" id="habit-tracker-title">
              {screen === 'insights'
                ? 'Your progress'
                : todayOnly
                  ? 'Today'
                  : weekOffset === 0
                    ? 'This week'
                    : weekOffset < 0
                      ? 'Previous week'
                      : 'Next week'}
            </Text>
            <Text variant="bodySmall" tone="muted">
              {screen === 'insights'
                ? 'See the pattern, then choose a day to update it.'
                : todayOnly
                  ? 'One day at a time. Check in with your habits below.'
                  : `${window.from} to ${window.to}`}
            </Text>
          </div>
          <Button
            variant="secondary"
            onClick={() => {
              setShowSetup((value) => !value);
            }}
          >
            {showSetup ? 'Close setup' : 'Add a habit'}
          </Button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <nav className="flex gap-1 rounded-lg bg-surface-raised p-1" aria-label="Habit screens">
            <Button
              variant={screen === 'checkins' && todayOnly ? 'primary' : 'ghost'}
              aria-pressed={screen === 'checkins' && todayOnly}
              onClick={() => {
                chooseTodayOnly(true);
                setWeekOffset(0);
              }}
            >
              Today
            </Button>
            <Button
              variant={screen === 'checkins' && !todayOnly ? 'primary' : 'ghost'}
              aria-label="Show week"
              aria-pressed={screen === 'checkins' && !todayOnly}
              onClick={() => {
                chooseTodayOnly(false);
              }}
            >
              Week
            </Button>
            <Button
              variant={screen === 'insights' ? 'primary' : 'ghost'}
              aria-pressed={screen === 'insights'}
              onClick={() => {
                setScreen('insights');
              }}
            >
              Insights
            </Button>
          </nav>
          <details>
            <summary
              className={cn(
                'flex min-h-6 cursor-pointer items-center rounded-md px-2 py-1 text-sm text-muted pointer-coarse:min-h-(--control-lg)',
                focusRing,
              )}
            >
              Display options
            </summary>
            <Button
              variant="ghost"
              aria-pressed={showArchived}
              onClick={() => {
                setShowArchived((value) => !value);
              }}
            >
              {showArchived ? 'Hide archived' : 'Show archived'}
            </Button>
          </details>
        </div>
        {screen === 'checkins' && !todayOnly ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              aria-label="Previous week"
              onClick={() => {
                setWeekOffset((value) => value - 1);
              }}
            >
              Previous
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setWeekOffset(0);
              }}
            >
              This week
            </Button>
            <Button
              variant="secondary"
              aria-label="Next week"
              onClick={() => {
                setWeekOffset((value) => value + 1);
              }}
            >
              Next
            </Button>
            <Text as="span" variant="caption" tone="muted">
              Select a day to check in or correct it.
            </Text>
          </div>
        ) : null}
      </header>
      {showSetup ? (
        <HabitSetup
          onCreate={async (title, settings) => {
            try {
              const created =
                createdHabitId.current === null
                  ? await client.execute(
                      items.createItem(workspace.workspaceId, {
                        type: 'note',
                        title,
                        parentId: container.itemId,
                      }),
                    )
                  : { id: createdHabitId.current };
              createdHabitId.current = created.id;
              const refusal = await state.saveHabit(created.id, settings);
              await container.reload();
              if (refusal === null) {
                createdHabitId.current = null;
                setShowSetup(false);
              }
              return refusal;
            } catch (reason) {
              return reason instanceof Error ? reason.message : 'The habit could not be created.';
            }
          }}
        />
      ) : null}
      {editingId !== null && state.trackers.get(editingId) !== undefined ? (
        <HabitSetup
          key={editingId}
          onCancel={() => {
            setEditingId(null);
          }}
          initial={state.trackers.get(editingId)}
          initialTitle={container.children.find((item) => item.id === editingId)?.title ?? ''}
          submitLabel="Save changes"
          onCreate={async (title, settings) => {
            const refusal = await state.saveHabit(editingId, settings);
            if (refusal === null) {
              const renameRefusal = await client
                .execute(items.renameItem(workspace.workspaceId, editingId, title))
                .then(() => null as string | null)
                .catch((reason: unknown) =>
                  reason instanceof Error ? reason.message : 'The habit name could not be saved.',
                );
              if (renameRefusal !== null) return renameRefusal;
              setEditingId(null);
              await container.reload();
            }
            return refusal;
          }}
        />
      ) : null}
      {state.status === 'loading' && state.trackers.size === 0 ? (
        <LoadingPanel label="habits" />
      ) : null}
      {state.status === 'error' ? (
        <ErrorPanel
          title="Habits could not be loaded"
          detail={state.error ?? 'Try again.'}
          action={<Button onClick={state.reload}>Retry</Button>}
        />
      ) : null}
      {container.children.length === 0 && state.status !== 'loading' ? (
        <EmptyPanel
          title="No habits yet"
          detail="Add a habit to begin your week."
          action={
            <Button
              onClick={() => {
                setShowSetup(true);
              }}
            >
              Add a habit
            </Button>
          }
        />
      ) : null}
      {container.truncated ? (
        <PartialNotice pending="Some habits have not been loaded. These totals cover the displayed habits only." />
      ) : null}
      {state.status === 'partial' ? (
        <div className="flex flex-wrap items-center gap-3">
          <PartialNotice pending={state.error ?? 'Some habits are unavailable.'} />
          <Button variant="secondary" onClick={state.reload}>
            Reload habits
          </Button>
        </div>
      ) : null}
      {habits.length === 0 && container.children.length > 0 && state.status !== 'error' ? (
        <EmptyPanel
          title="No configured habits"
          detail="Configure a habit to see it in this tracker."
          action={
            <Button
              onClick={() => {
                setShowSetup(true);
              }}
            >
              Add a habit
            </Button>
          }
        />
      ) : habits.length > 0 && screen === 'checkins' ? (
        <div className="min-w-0 overflow-x-auto">
          {todayOnly ? (
            <Text variant="bodySmall" tone="muted" className="mb-3">
              {
                habits
                  .filter((item) => item.tracker.status === 'active')
                  .filter((item) =>
                    item.tracker.checkIns.some(
                      (entry) =>
                        entry.occurredOn === todayInTimezone(item.tracker.timezone) &&
                        entry.completed,
                    ),
                  ).length
              }{' '}
              completed today. Each habit follows its saved timezone.
            </Text>
          ) : null}
          <table
            className={
              todayOnly ? 'block w-full border-collapse @lg:table' : 'w-full border-collapse'
            }
            aria-label={todayOnly ? 'Today habit check-ins' : 'Weekly habit check-ins'}
          >
            <thead className={todayOnly ? 'sr-only' : ''}>
              <tr>
                <th scope="col" className="p-2 text-left">
                  <Text variant="caption">Habit</Text>
                </th>
                {(todayOnly ? [dateText(new Date())] : window.days).map((day, index) => (
                  <th
                    key={day}
                    scope="col"
                    className={cn(
                      'p-2 text-center',
                      day === dateText(new Date()) && 'rounded-t-md bg-accent/10 text-accent',
                    )}
                  >
                    <Text variant="caption">
                      {todayOnly ? 'Today' : WEEKDAYS[index]?.slice(0, 3)}
                      <br />
                      {todayOnly ? '' : day.slice(8)}
                    </Text>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className={todayOnly ? 'block @lg:table-row-group' : ''}>
              {habits.map((item) => (
                <HabitRow
                  key={item.id}
                  itemId={item.id}
                  title={item.title}
                  days={todayOnly ? [todayInTimezone(item.tracker.timezone)] : window.days}
                  tracker={item.tracker}
                  onOpen={onOpen}
                  onSave={saveCheckInAndRefresh}
                  onUndo={undoCheckInAndRefresh}
                  onEdit={() => {
                    setEditingId(item.id);
                  }}
                  onStatus={state.setStatus}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <Text variant="bodySmall" tone="muted" className="sr-only">
        Progress is calculated from saved check-ins. Select a habit name to open its details.
      </Text>
      {habits.length > 0 && screen === 'insights' ? (
        <>
          <HabitInsights
            habits={habits}
            renderDay={(item, day, tracker) => renderHabitDay(item.id, day, tracker)}
          />
          <details>
            <summary
              className={cn(
                'flex min-h-6 cursor-pointer items-center rounded-md py-2 text-sm font-medium pointer-coarse:min-h-(--control-lg)',
                focusRing,
              )}
            >
              Custom charts{widgets.length > 0 ? ` (${String(widgets.length)})` : ''}
            </summary>
            <fieldset disabled={widgetsPending} className="mt-3">
              <HabitChartWidgets
                widgets={widgets}
                trackers={state.trackers}
                availableHabits={habits}
                renderDay={renderHabitDay}
                onChange={(next) => {
                  const previous = widgets;
                  setWidgetError(null);
                  const saved = container.views?.views.map((candidate) =>
                    candidate.id === view.id
                      ? { ...candidate, habitWidgets: [...next] }
                      : candidate,
                  );
                  if (saved === undefined) {
                    setWidgetError(
                      'Chart settings are unavailable. Reload this view and try again.',
                    );
                    return;
                  }
                  setWidgets(next);
                  setWidgetsPending(true);
                  void container.setViews(saved).then((refusal) => {
                    if (refusal !== null) {
                      setWidgets(previous);
                      setWidgetError(refusal);
                    }
                    setWidgetsPending(false);
                  });
                }}
              />
            </fieldset>
          </details>
        </>
      ) : null}
      {widgetError ? (
        <Text variant="note" role="alert">
          {widgetError}
        </Text>
      ) : null}
      {widgetsPending ? (
        <Text variant="caption" tone="muted">
          Saving widgets
        </Text>
      ) : null}
    </section>
  );
}

function HabitRow({
  itemId,
  title,
  days,
  tracker,
  onOpen,
  onSave,
  onUndo,
  onEdit,
  onStatus,
}: {
  readonly itemId: string;
  readonly title: string;
  readonly days: readonly string[];
  readonly tracker: HabitTracker;
  readonly onOpen: (id: string) => void;
  readonly onSave: (
    id: string,
    day: string,
    completed: boolean,
    quantity: number | null,
  ) => Promise<string | null>;
  readonly onUndo: (id: string, day: string) => Promise<string | null>;
  readonly onEdit: () => void;
  readonly onStatus: (
    id: string,
    status: 'active' | 'paused' | 'archived',
  ) => Promise<string | null>;
}): ReactNode {
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [statusPending, setStatusPending] = useState(false);
  const compact = days.length > 1;
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [quantities, setQuantities] = useState<Readonly<Record<string, string>>>({});
  // A day's completion, as tapped, ahead of the write and the refetch that confirms it. Cleared
  // once the tracker prop itself agrees, or rolled back on a refusal - see the render-time
  // adjustment below and `act`.
  const [optimistic, setOptimistic] = useState<Readonly<Record<string, boolean>>>({});
  const checkIns = new Map(tracker.checkIns.map((entry) => [entry.occurredOn, entry]));
  const occurrenceMap = new Map((tracker.occurrences ?? []).map((entry) => [entry.date, entry]));
  const lifecycle = tracker.status;
  // Adjusted during render rather than in an effect: a fresh `tracker` (the only thing that can
  // confirm an optimistic tick) has to drop any tick it now agrees with before this render paints,
  // not one render later. React re-renders immediately when state changes mid-render this way, so
  // there is no flash of the newly-confirmed tick reverting first.
  const [previousTracker, setPreviousTracker] = useState(tracker);
  if (previousTracker !== tracker) {
    setPreviousTracker(tracker);
    if (Object.keys(optimistic).length > 0) {
      const confirmed = Object.entries(optimistic).filter(([day, expected]) => {
        const entry = tracker.checkIns.find((candidate) => candidate.occurredOn === day);
        const occurrence = (tracker.occurrences ?? []).find((candidate) => candidate.date === day);
        const actual = occurrence?.completed ?? entry?.completed === true;
        return actual !== expected;
      });
      if (confirmed.length !== Object.keys(optimistic).length) {
        setOptimistic(Object.fromEntries(confirmed));
      }
    }
  }
  return (
    <tr
      className={
        compact ? 'border-b border-divider' : 'block border-b border-divider @lg:table-row'
      }
    >
      <th
        scope="row"
        className={
          compact
            ? 'min-w-40 p-3 text-left align-top'
            : 'block p-3 text-left align-middle @lg:table-cell'
        }
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Button
              variant="ghost"
              className="max-w-full justify-start truncate px-0 text-left text-lg font-semibold"
              aria-label={`Open ${title || 'Untitled habit'}`}
              onClick={() => {
                onOpen(itemId);
              }}
            >
              {title || 'Untitled habit'}
            </Button>
            <Text variant="caption" tone="muted">
              {tracker.target === 1 && tracker.unit === 'times'
                ? 'Check-in'
                : `Goal: ${String(tracker.target)} ${tracker.unit}`}
            </Text>
          </div>
          {lifecycle !== 'active' ? (
            <Text variant="caption" tone="muted" className="capitalize">
              {lifecycle}
            </Text>
          ) : null}
        </div>
        <details className="mt-1">
          <summary
            className={cn(
              'w-fit cursor-default rounded-md px-2 py-1 text-sm font-medium text-muted hover:bg-surface-raised',
              focusRing,
            )}
          >
            Habit options
          </summary>
          <div className="mt-2 flex flex-wrap items-center gap-1 rounded-md bg-surface-raised p-2">
            <Text variant="caption" tone="muted" className="px-2 capitalize">
              Status: {lifecycle}
            </Text>
            <Button variant="ghost" onClick={onEdit}>
              Edit schedule
            </Button>
            {lifecycle !== 'archived' ? (
              <Button
                variant="ghost"
                disabled={statusPending}
                onClick={() => {
                  setStatusPending(true);
                  void onStatus(itemId, lifecycle === 'paused' ? 'active' : 'paused').then(
                    (result) => {
                      setMessage(result);
                      setStatusPending(false);
                    },
                  );
                }}
              >
                {statusPending ? 'Saving' : lifecycle === 'paused' ? 'Resume' : 'Pause'}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              disabled={statusPending}
              onClick={() => {
                setStatusPending(true);
                void onStatus(itemId, lifecycle === 'archived' ? 'active' : 'archived').then(
                  (result) => {
                    setMessage(result);
                    setStatusPending(false);
                  },
                );
              }}
            >
              {lifecycle === 'archived' ? 'Restore' : 'Archive'}
            </Button>
          </div>
        </details>
        {message ? (
          <Text variant="note" role="alert">
            {message}
          </Text>
        ) : null}
      </th>
      {days.map((day) => {
        const entry = checkIns.get(day);
        const occurrence = occurrenceMap.get(day);
        const scheduled =
          occurrence?.scheduled ??
          (day >= tracker.startDate &&
            (tracker.frequency === 'daily' || tracker.weekdays.includes(weekdayFor(day))));
        const future = day > todayInTimezone(tracker.timezone);
        const hasEntry = entry !== undefined;
        const actual = occurrence?.completed ?? entry?.completed === true;
        // The optimistic tap wins over the last confirmed read until either the refetch this row
        // triggered agrees (the effect above clears it) or the write it followed is refused.
        const checked = optimistic[day] ?? actual;
        const stateLabel = future
          ? 'upcoming'
          : checked
            ? 'completed'
            : (occurrence?.state ??
              (hasEntry
                ? 'partial'
                : day === todayInTimezone(tracker.timezone)
                  ? 'scheduled'
                  : 'missed'));
        const key = `${itemId}:${day}`;
        const quantity =
          quantities[day] ??
          (entry?.quantity === null || entry?.quantity === undefined ? '' : String(entry.quantity));
        const target = occurrence?.target ?? tracker.target;
        const unit = occurrence?.unit ?? tracker.unit;
        const measured = target !== 1 || unit !== 'times';
        const invalidQuantity =
          measured &&
          (quantity.trim() === '' ||
            !Number.isFinite(Number(quantity)) ||
            Number(quantity) < 0 ||
            Number(quantity) > 1_000_000);
        const act = async (undo: boolean): Promise<void> => {
          setOptimistic((current) => ({
            ...current,
            [day]: !undo && (!measured || Number(quantity) >= target),
          }));
          setPending((current) => new Set(current).add(key));
          const refusal = undo
            ? await onUndo(itemId, day)
            : await onSave(itemId, day, true, measured ? Number(quantity) : null);
          setPending((current) => {
            const next = new Set(current);
            next.delete(key);
            return next;
          });
          if (refusal === null) {
            setQuantities((current) => {
              return Object.fromEntries(
                Object.entries(current).filter(([entryDay]) => entryDay !== day),
              );
            });
          } else {
            // The write was refused: the tap never happened as far as Core is concerned, so the
            // tick comes back off rather than sitting there until some later refetch disagrees
            // with it.
            setOptimistic((current) =>
              Object.fromEntries(Object.entries(current).filter(([entryDay]) => entryDay !== day)),
            );
          }
          setMessage(refusal);
        };
        return (
          <td
            key={day}
            className={cn(
              compact ? 'p-2 text-center align-top' : 'block p-3 align-middle @lg:table-cell',
              day === todayInTimezone(tracker.timezone) && compact && 'bg-accent/10',
            )}
          >
            {compact && selectedDay !== day ? (
              <Button
                variant={checked ? 'primary' : 'ghost'}
                className="h-10 w-10 p-0 pointer-coarse:size-(--control-lg)"
                disabled={future || (!scheduled && !hasEntry)}
                aria-label={`${title}, ${day}, ${future ? 'future' : checked ? 'completed' : scheduled ? 'not completed' : 'not scheduled'}`}
                aria-pressed={checked}
                title={`${day}: ${future ? 'Upcoming' : stateLabel}${entry?.quantity == null ? '' : `, ${String(entry.quantity)}/${String(target)} ${unit}`}`}
                onClick={() => {
                  setSelectedDay(day);
                }}
              >
                {checked ? (
                  <Check size={18} aria-hidden="true" />
                ) : !scheduled ? (
                  <Text as="span" variant="caption">
                    —
                  </Text>
                ) : stateLabel === 'partial' ? (
                  <Clock3 size={18} aria-hidden="true" />
                ) : stateLabel === 'missed' ? (
                  <CircleAlert size={18} aria-hidden="true" />
                ) : (
                  <Circle size={18} aria-hidden="true" />
                )}
              </Button>
            ) : scheduled || hasEntry ? (
              <div className="flex flex-wrap items-center justify-start gap-2 @lg:justify-end">
                {measured ? (
                  <Input
                    aria-label={`${title}, ${day}, quantity`}
                    className="w-24"
                    type="number"
                    min="0"
                    step="any"
                    value={quantity}
                    disabled={pending.has(key) || future || lifecycle !== 'active'}
                    onChange={(event) => {
                      setQuantities((current) => ({ ...current, [day]: event.target.value }));
                    }}
                  />
                ) : null}
                <Button
                  variant={checked ? 'primary' : 'secondary'}
                  disabled={pending.has(key) || future || invalidQuantity || lifecycle !== 'active'}
                  aria-label={
                    measured
                      ? `Save ${title}, ${day}, quantity`
                      : `${checked ? 'Done: undo check-in for' : 'Check in'} ${title}, ${day}${future ? ', upcoming' : ''}`
                  }
                  aria-pressed={checked}
                  onClick={() => {
                    void act(!measured && checked);
                  }}
                >
                  {!measured && checked ? <Check size={18} aria-hidden="true" /> : null}
                  {pending.has(key) ? 'Saving' : measured ? 'Save' : checked ? 'Done' : 'Check in'}
                </Button>
                <Text
                  variant="caption"
                  tone="muted"
                  className="inline-flex items-center gap-1 capitalize"
                >
                  <span aria-hidden="true">
                    {stateLabel === 'completed' ? (
                      <CheckCircle2 size={14} />
                    ) : stateLabel === 'missed' ? (
                      <CircleAlert size={14} />
                    ) : stateLabel === 'partial' ? (
                      <Clock3 size={14} />
                    ) : (
                      <Circle size={14} />
                    )}
                  </span>
                  {stateLabel === 'scheduled'
                    ? 'Due today'
                    : stateLabel === 'missed'
                      ? 'No check-in'
                      : stateLabel === 'partial'
                        ? 'Partly done'
                        : stateLabel}
                </Text>
                {measured && hasEntry ? (
                  <Button
                    variant="ghost"
                    disabled={pending.has(key) || future || lifecycle !== 'active'}
                    aria-label={`Undo ${title}, ${day}`}
                    onClick={() => {
                      void act(true);
                    }}
                  >
                    Undo
                  </Button>
                ) : null}
                {measured && entry ? (
                  <Text variant="caption" tone="muted">
                    {`${String(entry.quantity ?? 0)}/${String(target)} ${unit}`}
                  </Text>
                ) : null}
                {compact ? (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setSelectedDay(null);
                    }}
                  >
                    Close
                  </Button>
                ) : null}
              </div>
            ) : (
              <Text variant="caption" tone="muted">
                Not scheduled
              </Text>
            )}
          </td>
        );
      })}
    </tr>
  );
}

function HabitSetup({
  onCreate,
  initial,
  initialTitle,
  submitLabel = 'Create habit',
  onCancel,
}: {
  readonly onCreate: (title: string, settings: SetHabitInput) => Promise<string | null>;
  readonly initial?: HabitTracker | undefined;
  readonly initialTitle?: string;
  readonly submitLabel?: string;
  readonly onCancel?: () => void;
}): ReactNode {
  const [title, setTitle] = useState(initialTitle ?? '');
  const [error, setError] = useState<string | null>(null);
  const [frequency, setFrequency] = useState<'daily' | 'weekly'>(initial?.frequency ?? 'daily');
  const [startDate, setStartDate] = useState(initial?.startDate ?? dateText(new Date()));
  const [target, setTarget] = useState(String(initial?.target ?? 1));
  const [unit, setUnit] = useState(initial?.unit ?? 'times');
  const [pending, setPending] = useState(false);
  const [weekdays, setWeekdays] = useState<ReadonlySet<number>>(
    new Set(initial?.weekdays ?? [1, 2, 3, 4, 5]),
  );
  const [timezone, setTimezone] = useState(initial?.timezone ?? localTimeZone());
  // Empty means no reminder. Core fires it at this local time, in the habit's own zone, on a
  // scheduled day that has no check-in yet (ADR-0051 section 4).
  const [reminderTime, setReminderTime] = useState(initial?.reminderTime ?? '');
  return (
    <form
      className="flex flex-wrap items-end gap-3 border border-divider p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        setPending(true);
        void onCreate(title.trim(), {
          frequency,
          weekdays: frequency === 'weekly' ? [...weekdays] : [],
          timezone,
          startDate,
          target: Number(target),
          unit: unit.trim() || 'times',
          reminderTime: reminderTime === '' ? null : reminderTime,
        }).then((refusal) => {
          setError(refusal);
          setPending(false);
        });
      }}
    >
      <Field label="Habit name">
        {(control) => (
          <Input
            {...control}
            value={title}
            required
            onChange={(event) => {
              setTitle(event.target.value);
            }}
          />
        )}
      </Field>
      <Field label="Frequency">
        {(control) => (
          <Select
            {...control}
            value={frequency}
            onChange={(event) => {
              setFrequency(event.target.value as 'daily' | 'weekly');
            }}
          >
            <option value="daily">Every day</option>
            <option value="weekly">Selected days</option>
          </Select>
        )}
      </Field>
      {frequency === 'weekly' ? (
        <fieldset className="flex flex-wrap gap-2">
          <legend>
            <Text variant="caption">Days</Text>
          </legend>
          {WEEKDAYS.map((name, index) => (
            <Checkbox
              key={name}
              label={name.slice(0, 3)}
              checked={weekdays.has(index === 6 ? 0 : index + 1)}
              onChange={() => {
                setWeekdays((current) => {
                  const next = new Set(current);
                  const value = index === 6 ? 0 : index + 1;
                  if (next.has(value)) next.delete(value);
                  else next.add(value);
                  return next;
                });
              }}
            />
          ))}
        </fieldset>
      ) : null}
      <Field label="Starts">
        {(control) => (
          <Input
            {...control}
            type="date"
            value={startDate}
            onChange={(event) => {
              setStartDate(event.target.value);
            }}
          />
        )}
      </Field>
      <Field label="Timezone">
        {(control) => (
          <Input
            {...control}
            value={timezone}
            onChange={(event) => {
              setTimezone(event.target.value);
            }}
          />
        )}
      </Field>
      <Field label="Reminder time" hint="Leave empty for no reminder.">
        {(control) => (
          <Input
            {...control}
            type="time"
            value={reminderTime}
            onChange={(event) => {
              setReminderTime(event.target.value);
            }}
          />
        )}
      </Field>
      <Field label="Target">
        {(control) => (
          <Input
            {...control}
            type="number"
            min="0.000001"
            step="any"
            value={target}
            onChange={(event) => {
              setTarget(event.target.value);
            }}
          />
        )}
      </Field>
      <Field label="Unit">
        {(control) => (
          <Input
            {...control}
            value={unit}
            onChange={(event) => {
              setUnit(event.target.value);
            }}
          />
        )}
      </Field>
      <Button
        type="submit"
        disabled={
          pending ||
          title.trim() === '' ||
          !Number.isFinite(Number(target)) ||
          Number(target) <= 0 ||
          Number(target) > 1_000_000 ||
          (frequency === 'weekly' && weekdays.size === 0)
        }
      >
        {pending ? 'Saving' : submitLabel}
      </Button>
      {onCancel === undefined ? null : (
        <Button variant="secondary" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
      )}
      {error ? (
        <Text variant="note" tone="muted" role="alert">
          {error}
        </Text>
      ) : null}
    </form>
  );
}
