import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HabitTracker } from '@nix/api-client';
import type { ContainerData } from '../../../views/core/use-container';
import { aContainer } from '../../container-fixture';
import { stubViewport } from '../../stub-viewport';
import { HabitTrackerView } from '../../../views/habit-tracker/habit-tracker-view';
import type { View } from '../../../views/core/container-model';

const saveHabit = vi.fn<() => Promise<string | null>>();
const saveCheckIn = vi.fn<() => Promise<string | null>>();
const undoCheckIn = vi.fn<() => Promise<string | null>>();
const setStatus = vi.fn<() => Promise<string | null>>();
const refetchHabit = vi.fn<(habitId: string) => Promise<string | null>>();
const execute = vi.fn<() => Promise<{ id: string }>>();
const reload = vi.fn(() => Promise.resolve());
let tracker: HabitTracker;
// Set only by the test that checks a second habit is left alone; every other test's mock is a
// single-habit tracker map, exactly as before.
let secondTracker: HabitTracker | undefined;

vi.mock('../../../views/habit-tracker/use-habits', () => ({
  useHabits: () => ({
    status: 'ready',
    trackers: new Map(
      secondTracker === undefined
        ? [['habit-1', tracker]]
        : [
            ['habit-1', tracker],
            ['habit-2', secondTracker],
          ],
    ),
    error: null,
    version: 0,
    refreshingIds: new Set(),
    reload,
    refetchHabit,
    saveHabit,
    saveCheckIn,
    undoCheckIn,
    setStatus,
  }),
}));
vi.mock('../../../api/api-client-provider', () => ({ useApiClient: () => ({ execute }) }));
vi.mock('../../../workspaces/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: 'workspace-1' }),
}));
vi.mock('../../../views/habit-tracker/habit-chart-widgets', () => ({
  HabitChartWidgets: ({ onChange }: { onChange: (widgets: readonly unknown[]) => void }) => (
    <button
      onClick={() => {
        onChange([{ id: 'widget-1', kind: 'streak', habitIds: ['habit-1'] }]);
      }}
    >
      Add chart widget
    </button>
  ),
}));

const view: View = {
  id: 'view-1',
  name: 'Habits',
  kind: 'habit_tracker',
  columns: [],
  groupOrder: [],
  filters: [],
  dateProperty: null,
  groupBy: null,
  sortBy: null,
  sortDescending: false,
  mode: null,
  coverProperty: null,
  endDateProperty: null,
  cardSize: null,
  layout: null,
  habitWidgets: [],
};
const habit = {
  id: 'habit-1',
  workspaceId: 'workspace-1',
  parentId: 'container-1',
  type: 'note',
  title: 'Read',
  hasChildren: false,
  seq: 1,
  lifecycleState: 'active' as const,
  properties: {},
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
const mount = (empty = false, suppliedContainer?: ContainerData) =>
  render(
    <HabitTrackerView
      container={suppliedContainer ?? aContainer({ children: empty ? [] : [habit] })}
      view={view}
      onOpen={vi.fn()}
    />,
  );

describe('habit tracker user flows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    secondTracker = undefined;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-18T12:00:00Z'));
    tracker = {
      habitId: 'habit-1',
      frequency: 'daily',
      weekdays: [],
      timezone: 'UTC',
      startDate: '2026-03-16',
      target: 2,
      unit: 'pages',
      checkIns: [{ id: 'check-1', occurredOn: '2026-03-16', completed: false, quantity: 1 }],
      weeks: [{ weekStart: '2026-03-16', planned: 7, completed: 0, quantity: 1 }],
      status: 'active',
      occurrences: null,
      progress: null,
      months: null,
    };
    saveHabit.mockResolvedValue(null);
    saveCheckIn.mockResolvedValue(null);
    undoCheckIn.mockResolvedValue(null);
    setStatus.mockResolvedValue(null);
    refetchHabit.mockResolvedValue(null);
    execute.mockResolvedValue({ id: 'created-habit' });
  });
  afterEach(() => vi.useRealTimers());

  it('creates from the empty state and retries refused settings on the same item', async () => {
    saveHabit.mockResolvedValueOnce('Choose a different setting.');
    mount(true);
    const add = screen.getAllByRole('button', { name: 'Add a habit' }).at(0);
    if (add === undefined) throw new Error('Missing habit creation control');
    fireEvent.click(add);
    fireEvent.change(screen.getByRole('textbox', { name: 'Habit name' }), {
      target: { value: 'Walk' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create habit' }));
    await screen.findByRole('alert');
    expect(saveHabit).toHaveBeenCalledWith(
      'created-habit',
      expect.objectContaining({ frequency: 'daily', target: 1 }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create habit' }));
    await waitFor(() => {
      expect(saveHabit).toHaveBeenCalledTimes(2);
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('updates a partial quantity and offers independent undo', async () => {
    mount();
    const quantity = screen.getByRole('spinbutton', { name: 'Read, 2026-03-16, quantity' });
    expect(quantity).toHaveValue(1);
    fireEvent.change(quantity, { target: { value: '2' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Read, 2026-03-16, not completed' }));
      await Promise.resolve();
    });
    expect(saveCheckIn).toHaveBeenCalledWith('habit-1', '2026-03-16', true, 2);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Undo Read, 2026-03-16' }));
      await Promise.resolve();
    });
    expect(undoCheckIn).toHaveBeenCalledWith('habit-1', '2026-03-16');
  });

  it('refuses an empty quantity even for a target of one with a custom unit', () => {
    tracker = { ...tracker, target: 1, unit: 'glass', checkIns: [] };
    mount();
    expect(screen.getByRole('spinbutton', { name: 'Read, 2026-03-16, quantity' })).toHaveValue(
      null,
    );
    expect(screen.getByRole('button', { name: 'Read, 2026-03-16, not completed' })).toBeDisabled();
  });

  it('uses the saved timezone for Today and disables future weekly cells', async () => {
    vi.setSystemTime(new Date('2026-03-18T23:00:00Z'));
    tracker = { ...tracker, timezone: 'Asia/Tokyo', target: 1, unit: 'times' };
    mount();
    expect(screen.getByRole('button', { name: 'Read, 2026-03-20, future' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Read, 2026-03-19, not completed' }));
      await Promise.resolve();
    });
    expect(saveCheckIn).toHaveBeenCalledWith('habit-1', '2026-03-19', true, null);
  });

  it('shows a refused mutation without claiming completion', async () => {
    tracker = { ...tracker, target: 1, unit: 'times', checkIns: [] };
    saveCheckIn.mockResolvedValue('Permission changed. Reload the habit.');
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Read, 2026-03-18, not completed' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Permission changed');
    expect(screen.getByRole('button', { name: 'Read, 2026-03-18, not completed' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('ticks the moment it is tapped, ahead of the write resolving', async () => {
    tracker = { ...tracker, target: 1, unit: 'times', checkIns: [] };
    let resolveSave: (refusal: string | null) => void = () => undefined;
    saveCheckIn.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Read, 2026-03-18, not completed' }));
    // The write has not resolved yet - saveCheckIn's own promise is still pending - but the tap
    // already reads as completed rather than waiting for a round trip.
    expect(screen.getByRole('button', { name: 'Read, 2026-03-18, completed' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await act(async () => {
      resolveSave(null);
      await Promise.resolve();
    });
    expect(refetchHabit).toHaveBeenCalledWith('habit-1');
  });

  it('rolls the tick back when the write is refused', async () => {
    tracker = { ...tracker, target: 1, unit: 'times', checkIns: [] };
    let resolveSave: (refusal: string | null) => void = () => undefined;
    saveCheckIn.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Read, 2026-03-18, not completed' }));
    expect(screen.getByRole('button', { name: 'Read, 2026-03-18, completed' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await act(async () => {
      resolveSave('Permission changed. Reload the habit.');
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'Read, 2026-03-18, not completed' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Permission changed');
    // The write was refused, so there is nothing for either window to refetch.
    expect(refetchHabit).not.toHaveBeenCalled();
  });

  it('refetches only the habit that changed, not every habit in the container', async () => {
    tracker = { ...tracker, target: 1, unit: 'times', checkIns: [] };
    secondTracker = { ...tracker, habitId: 'habit-2' };
    const secondHabit = { ...habit, id: 'habit-2', title: 'Walk' };
    mount(false, aContainer({ children: [habit, secondHabit] }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Read, 2026-03-18, not completed' }));
      await Promise.resolve();
    });
    // The week window and the month window each refetch the one habit that changed - two calls,
    // both for habit-1, none for habit-2 - rather than reloading every habit in either window.
    expect(refetchHabit).toHaveBeenCalledTimes(2);
    expect(refetchHabit).toHaveBeenCalledWith('habit-1');
    expect(refetchHabit).not.toHaveBeenCalledWith('habit-2');
  });

  it('allows custom weekday selection and navigation to a previous week', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Previous week' }));
    expect(screen.getByText('2026-03-09 to 2026-03-15')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Add a habit' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Frequency' }), {
      target: { value: 'weekly' },
    });
    expect(screen.getByRole('checkbox', { name: 'Mon' })).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Mon' }));
    expect(screen.getByRole('checkbox', { name: 'Mon' })).not.toBeChecked();
  });

  it('pauses an active habit and exposes its status', async () => {
    mount();
    fireEvent.click(screen.getByText('Habit options'));
    expect(screen.getByText('Status: active')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => {
      expect(setStatus).toHaveBeenCalledWith('habit-1', 'paused');
    });
  });

  it('edits the habit name, timezone, and schedule on the existing item', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Edit schedule' }));
    expect(screen.getByRole('textbox', { name: 'Habit name' })).toHaveValue('Read');
    fireEvent.change(screen.getByRole('textbox', { name: 'Habit name' }), {
      target: { value: 'Read nightly' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Timezone' }), {
      target: { value: 'America/New_York' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      expect(saveHabit).toHaveBeenCalledWith(
        'habit-1',
        expect.objectContaining({ timezone: 'America/New_York' }),
      );
    });
    expect(execute).toHaveBeenCalled();
  });

  it('persists widget changes and restores the prior selection when saving fails', async () => {
    const container = aContainer({ children: [habit] });
    const setViews = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValue('Widget settings could not be saved.');
    Object.assign(container, { setViews, views: { views: [view], defaultView: view.id } });
    mount(false, container);
    fireEvent.click(screen.getByRole('button', { name: 'Add chart widget' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Widget settings could not be saved',
    );
    expect(setViews).toHaveBeenCalled();
  });
});

describe('habit tracker narrow-screen default', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    secondTracker = undefined;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-18T12:00:00Z'));
    tracker = {
      habitId: 'habit-1',
      frequency: 'daily',
      weekdays: [],
      timezone: 'UTC',
      startDate: '2026-03-16',
      target: 1,
      unit: 'times',
      checkIns: [],
      weeks: [{ weekStart: '2026-03-16', planned: 7, completed: 0, quantity: 1 }],
      status: 'active',
      occurrences: null,
      progress: null,
      months: null,
    };
    saveHabit.mockResolvedValue(null);
    saveCheckIn.mockResolvedValue(null);
    undoCheckIn.mockResolvedValue(null);
    setStatus.mockResolvedValue(null);
    refetchHabit.mockResolvedValue(null);
    execute.mockResolvedValue({ id: 'created-habit' });
  });
  afterEach(() => {
    vi.useRealTimers();
    // Restores `setup.ts`'s own wide default for every test after this one - see that module's
    // comment for why a test that narrows the viewport is the one that has to put it back.
    stubViewport(true);
  });

  it('defaults to Today on a narrow screen', () => {
    stubViewport(false);
    mount();
    expect(screen.getByRole('heading', { name: 'Today' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Show week' })).toBeVisible();
  });

  it('defaults to the week on a screen wide enough for it', () => {
    stubViewport(true);
    mount();
    expect(screen.getByRole('heading', { name: 'This week' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Today' })).toBeVisible();
  });

  it("keeps the person's own choice over the narrow-screen default", () => {
    stubViewport(false);
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Show week' }));
    expect(screen.getByRole('heading', { name: 'This week' })).toBeVisible();
  });
});
