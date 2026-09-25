import { Button, Checkbox, cn, Field, focusRing, Input, Select, Text } from '@nix/ui';
import { items } from '@nix/api-client';
import { CheckCircle2, Circle, CircleAlert, Clock3 } from 'lucide-react';
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
import { useNarrowViewport } from '../../layout/viewport';
import { browserStorage } from '../../lib/browser-storage';
import { formatShortDate, localTimeZone } from '../../lib/date-format';
import { HabitChartWidgets, type HabitWidgetConfig } from './habit-chart-widgets';

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

function monthWindow(day: string): { from: string; to: string } {
  const date = new Date(`${day}T00:00:00Z`);
  const from = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const to = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
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
  const narrow = useNarrowViewport();
  // `null` means the person has never chosen: a narrow screen defaults to Today, since seven
  // full-width day blocks stacked on a phone is what this default exists to avoid. Once they pick
  // either way, the stored choice wins over the screen width from then on.
  const [todayOnlyChoice, setTodayOnlyChoice] = useState<boolean | null>(() =>
    readStoredTodayOnly(browserStorage()),
  );
  const todayOnly = todayOnlyChoice ?? narrow;
  const chooseTodayOnly = useCallback((value: boolean) => {
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
  const state = useHabits(
    ids,
    todayOnly ? shiftedDay(window.from, -1) : window.from,
    todayOnly ? shiftedDay(window.to, 1) : window.to,
  );
  const month = monthWindow(window.from);
  const monthlyState = useHabits(ids, month.from, month.to);
  const { reload: reloadMonth } = monthlyState;
  const localDaySignature = ids
    .map((id) => `${id}:${todayInTimezone(state.trackers.get(id)?.timezone ?? 'UTC')}`)
    .join('|');
  const previousLocalDaySignature = useRef(localDaySignature);
  const observedLocalDays = useRef(false);
  // Watches `version`, not `trackers`' identity: a single-habit `refetchHabit` also replaces the
  // `trackers` map, and cascading a full month reload from that would put the 2N requests this
  // hook exists to avoid right back - one habit's check-in refetching every habit's month data.
  const previousVersion = useRef(state.version);
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
      reloadMonth();
    }
  }, [localDaySignature, reloadMonth, state]);
  useEffect(() => {
    if (state.status === 'loading') return;
    if (previousVersion.current !== state.version) {
      previousVersion.current = state.version;
      reloadMonth();
    }
  }, [reloadMonth, state.status, state.version]);
  const client = useApiClient();
  const workspace = useWorkspace();
  const createdHabitId = useRef<string | null>(null);
  // A check-in changes exactly one habit's totals, in both the week window and the month window.
  // Reloading every habit in either range - what a full `reload` does - would cost 2N requests for
  // a single tap; refetching just this habit in each range costs two.
  const refetchHabitEverywhere = useCallback(
    (habitId: string) => {
      void state.refetchHabit(habitId);
      void monthlyState.refetchHabit(habitId);
    },
    [state, monthlyState],
  );
  const saveCheckInAndRefresh = useCallback(
    async (
      habitId: string,
      day: string,
      completed: boolean,
      quantity: number | null,
    ): Promise<string | null> => {
      const refusal = await state.saveCheckIn(habitId, day, completed, quantity);
      if (refusal === null) refetchHabitEverywhere(habitId);
      return refusal;
    },
    [state, refetchHabitEverywhere],
  );
  const undoCheckInAndRefresh = useCallback(
    async (habitId: string, day: string): Promise<string | null> => {
      const refusal = await state.undoCheckIn(habitId, day);
      if (refusal === null) refetchHabitEverywhere(habitId);
      return refusal;
    },
    [state, refetchHabitEverywhere],
  );
  const habits = container.children.flatMap((item) => {
    const tracker = state.trackers.get(item.id);
    if (!showArchived && tracker?.status === 'archived') return [];
    return tracker === undefined ? [] : [{ ...item, tracker }];
  });

  return (
    <section className="flex min-w-0 flex-col gap-6" aria-labelledby="habit-tracker-title">
      <header className="flex flex-col gap-4 border-b border-divider pb-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Text as="h2" variant="h2" id="habit-tracker-title">
            {todayOnly
              ? 'Today'
              : weekOffset === 0
                ? 'This week'
                : weekOffset < 0
                  ? 'Previous week'
                  : 'Next week'}
          </Text>
          <Text variant="bodySmall" tone="muted">
            {todayOnly
              ? 'Each habit follows its saved timezone.'
              : `${window.from} to ${window.to}`}
          </Text>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-end">
          <Button
            variant="secondary"
            aria-pressed={todayOnly}
            onClick={() => {
              chooseTodayOnly(!todayOnly);
              setWeekOffset(0);
            }}
          >
            {todayOnly ? 'Show week' : 'Today'}
          </Button>
          <Button
            variant="secondary"
            aria-label="Previous week"
            onClick={() => {
              chooseTodayOnly(false);
              setWeekOffset((value) => value - 1);
            }}
          >
            Previous
          </Button>
          <Button
            variant="secondary"
            aria-label="Next week"
            onClick={() => {
              chooseTodayOnly(false);
              setWeekOffset((value) => value + 1);
            }}
          >
            Next
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setShowSetup((value) => !value);
            }}
          >
            {showSetup ? 'Close setup' : 'Add a habit'}
          </Button>
          <Button
            variant="secondary"
            aria-pressed={showArchived}
            onClick={() => {
              setShowArchived((value) => !value);
            }}
          >
            {showArchived ? 'Hide archived' : 'Show archived'}
          </Button>
        </div>
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
        <PartialNotice pending={state.error ?? 'Some habits are unavailable.'} />
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
      ) : habits.length > 0 ? (
        <div className="min-w-0">
          <table
            className="block w-full border-collapse md:table"
            aria-label="Weekly habit check-ins"
          >
            <thead className="hidden md:table-header-group">
              <tr>
                <th scope="col" className="p-2 text-left">
                  <Text variant="caption">Habit</Text>
                </th>
                {(todayOnly ? [dateText(new Date())] : window.days).map((day, index) => (
                  <th key={day} scope="col" className="p-2 text-center">
                    <Text variant="caption">
                      {todayOnly ? 'Today' : WEEKDAYS[index]?.slice(0, 3)}
                      <br />
                      {todayOnly ? '' : day.slice(8)}
                    </Text>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="block space-y-4 md:table-row-group md:space-y-0">
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
      {habits.length > 0 ? (
        <div
          className="grid gap-3 border-t border-divider pt-4 sm:grid-cols-2 xl:grid-cols-3"
          aria-label="Habit progress"
        >
          {habits.map((item) => {
            const progress = item.tracker.progress;
            const updating = state.refreshingIds.has(item.id);
            return (
              <div key={item.id} className="rounded-lg bg-surface-raised p-3">
                <Text variant="bodySmall" className="font-medium">
                  {item.title}
                </Text>
                {updating ? (
                  <Text variant="caption" tone="muted">
                    Updating
                  </Text>
                ) : (
                  <Text variant="caption" tone="muted">
                    {progress?.currentStreak ?? 0} day streak · {progress?.bestStreak ?? 0} best ·{' '}
                    {Math.round((progress?.completionRate ?? 0) * 100)}% complete
                  </Text>
                )}
              </div>
            );
          })}
          <Text
            variant="bodySmall"
            tone="muted"
            className="self-center sm:col-span-2 xl:col-span-3"
          >
            {habits.some((item) => state.refreshingIds.has(item.id)) ? (
              'Overall: updating'
            ) : (
              <>
                Overall:{' '}
                {(() => {
                  const planned = habits.reduce(
                    (sum, item) => sum + (item.tracker.progress?.planned ?? 0),
                    0,
                  );
                  const completed = habits.reduce(
                    (sum, item) => sum + (item.tracker.progress?.completed ?? 0),
                    0,
                  );
                  return planned === 0 ? 0 : Math.round((completed / planned) * 100);
                })()}
                % of scheduled days
              </>
            )}
          </Text>
        </div>
      ) : null}
      {monthlyState.status === 'loading' ? (
        <Text variant="bodySmall" tone="muted">
          Loading monthly history
        </Text>
      ) : null}
      {monthlyState.status === 'partial' ? (
        <PartialNotice pending={monthlyState.error ?? 'Some monthly totals are unavailable.'} />
      ) : null}
      {monthlyState.status === 'error' ? (
        <Text variant="bodySmall" tone="muted" role="alert">
          Monthly history could not be loaded: {monthlyState.error ?? 'Try again.'}
        </Text>
      ) : null}
      {monthlyState.status !== 'error' && monthlyState.status !== 'loading' && habits.length > 0 ? (
        <div aria-label="Monthly habit history">
          {habits.map((item) => {
            if (monthlyState.refreshingIds.has(item.id)) {
              return (
                <Text key={item.id} variant="bodySmall" tone="muted">
                  {item.title}: updating this month&apos;s total
                </Text>
              );
            }
            const monthly = monthlyState.trackers.get(item.id);
            const totals = monthly?.months?.at(-1);
            return totals ? (
              <Text key={item.id} variant="bodySmall" tone="muted">
                {item.title}: {String(totals.completed)}/{String(totals.planned)} completed this
                month
                {item.tracker.unit === 'times'
                  ? ''
                  : `, ${String(totals.quantity)} ${item.tracker.unit}`}
              </Text>
            ) : null;
          })}
        </div>
      ) : null}
      {habits.length > 0 ? (
        <fieldset
          disabled={widgetsPending}
          className="min-w-0"
          aria-label="Progress chart configuration"
        >
          <HabitChartWidgets
            widgets={widgets}
            trackers={state.trackers}
            availableHabits={habits.map((item) => ({ id: item.id, title: item.title }))}
            onChange={(next) => {
              const previous = widgets;
              setWidgetError(null);
              setWidgets(next);
              const saved = container.views?.views.map((candidate) =>
                candidate.id === view.id ? { ...candidate, habitWidgets: [...next] } : candidate,
              );
              if (saved === undefined) return;
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
      {habits.length > 0 && !todayOnly ? (
        <div
          className="flex flex-wrap gap-4 border-t border-divider pt-3"
          aria-label="Progress summary"
        >
          {habits.map((item) => {
            if (state.refreshingIds.has(item.id)) {
              return (
                <Text key={item.id} variant="bodySmall">
                  {item.title}: updating
                </Text>
              );
            }
            const tracker = state.trackers.get(item.id);
            const week = tracker?.weeks[0];
            return tracker && week ? (
              <Text key={item.id} variant="bodySmall">
                {item.title}: {week.completed}/{week.planned} complete
                {tracker.unit === 'times' ? '' : `, ${String(week.quantity)} ${tracker.unit}`}
              </Text>
            ) : null;
          })}
        </div>
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
    <tr className="block overflow-hidden rounded-lg border border-divider bg-surface md:table-row md:rounded-none md:border-0">
      <th
        scope="row"
        className="block p-4 text-left align-top md:table-cell md:w-64 md:border-t md:border-divider md:p-3"
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
              Goal: {tracker.target} {tracker.unit}
            </Text>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
              <Text variant="caption" tone="muted">
                {tracker.progress?.currentStreak ?? 0} day streak
              </Text>
              <Text variant="caption" tone="muted">
                {Math.round((tracker.progress?.completionRate ?? 0) * 100)}% complete
              </Text>
            </div>
          </div>
          <Text
            variant="caption"
            tone="muted"
            className="rounded-full border border-divider px-2 py-1 capitalize"
          >
            {lifecycle}
          </Text>
        </div>
        <details className="mt-3">
          <summary
            className={cn(
              'w-fit cursor-pointer rounded-md px-2 py-1 text-sm font-medium text-muted hover:bg-surface-raised',
              focusRing,
            )}
          >
            Habit options
          </summary>
          <div className="mt-2 flex flex-wrap items-center gap-1 rounded-md bg-surface-raised p-2 md:flex-col md:items-stretch">
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
      {days.map((day, dayIndex) => {
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
        const stateLabel =
          occurrence?.state ?? (checked ? 'completed' : hasEntry ? 'partial' : 'scheduled');
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
          setOptimistic((current) => ({ ...current, [day]: !undo }));
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
            className="block border-t border-divider p-3 text-left align-middle md:table-cell md:p-2 md:text-center"
          >
            <div className="mb-2 flex items-baseline justify-between md:hidden">
              <Text variant="bodySmall" className="font-medium">
                {days.length === 1 ? 'Today' : WEEKDAYS[dayIndex]}
              </Text>
              <Text variant="caption" tone="muted">
                {day}
              </Text>
            </div>
            {scheduled || hasEntry ? (
              <div className="flex flex-wrap items-center justify-between gap-2 md:justify-center">
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
                  aria-label={`${title}, ${day}, ${future ? 'future' : checked ? 'completed' : 'not completed'}`}
                  aria-pressed={checked}
                  onClick={() => {
                    void act(!measured && checked);
                  }}
                >
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
                  {stateLabel}
                </Text>
                {measured && hasEntry ? (
                  <Button
                    variant="ghost"
                    disabled={pending.has(key) || future}
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
                    {entry.completed
                      ? 'Complete'
                      : `${String(entry.quantity ?? 0)}/${String(target)} ${unit}`}
                  </Text>
                ) : null}
              </div>
            ) : (
              <Text variant="caption" tone="muted">
                —
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
}: {
  readonly onCreate: (title: string, settings: SetHabitInput) => Promise<string | null>;
  readonly initial?: HabitTracker | undefined;
  readonly initialTitle?: string;
  readonly submitLabel?: string;
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
      {error ? (
        <Text variant="note" tone="muted" role="alert">
          {error}
        </Text>
      ) : null}
    </form>
  );
}
