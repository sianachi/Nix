import { Button, cn, focusRing, Text } from '@nix/ui';
import { items } from '@nix/api-client';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ShownItems } from '../core/item-selection-context';
import type { ContainerData } from '../core/use-container';
import type { View } from '../core/container-model';
import {
  EmptyPanel,
  ErrorPanel,
  LoadingPanel,
  PartialNotice,
} from '../../components/states/status-panels';
import { useHabits } from './use-habits';
import type { HabitTracker } from '@nix/api-client';
import { useApiClient } from '../../api/api-client-provider';
import { useWorkspace } from '../../workspaces/workspace-context';
import { browserStorage } from '../../lib/browser-storage';
import { HabitChartWidgets, type HabitWidgetConfig } from './habit-chart-widgets';
import { HabitInsights } from './habit-insights';
import { HabitRow } from './habit-row';
import { HabitSetup } from './habit-setup';
import { dateText, shiftedDay, todayInTimezone, weekWindow, WEEKDAYS } from './habit-days';

// The tracker's public surface stays here; My Day and tests import these from this module.
export { HabitSetup, todayInTimezone, weekWindow };

export interface HabitTrackerViewProps {
  readonly container: ContainerData;
  readonly view: View;
  readonly onOpen: (itemId: string) => void;
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
  const shownHabitIds =
    screen === 'checkins' && (state.status === 'ready' || state.status === 'partial')
      ? habits.map((item) => item.id)
      : [];

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
            <Text as="h2" variant="h4" id="habit-tracker-title">
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
          <nav
            className="flex max-w-full flex-wrap gap-1 rounded-lg bg-surface-raised p-1"
            aria-label="Habit screens"
          >
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
                'flex min-h-6 cursor-pointer items-center rounded-md px-2 py-1 text-sm text-muted any-pointer-coarse:min-h-(--control-lg)',
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
      <ShownItems ids={shownHabitIds} />
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
        <div
          role="region"
          aria-label={todayOnly ? 'Today habit check-ins' : 'Weekly habit check-ins'}
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Justification: keyboard users need to scroll weekly check-ins.
          tabIndex={0}
          className={cn('min-w-0 max-w-full overflow-x-auto', focusRing)}
        >
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
                'flex min-h-6 cursor-pointer items-center rounded-md py-2 text-sm font-medium any-pointer-coarse:min-h-(--control-lg)',
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
