import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HabitTracker, MyDay, MyDayHabitRow, MyDayTaskRow } from '@nix/api-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MyDayState } from '../../my-day/use-my-day';
import { MyDayPage } from '../../pages/my-day-page';

const WORKSPACE = 'a1111111-1111-4111-8111-111111111111';
const completeTask = vi.fn<MyDayState['completeTask']>();
const checkIn = vi.fn<MyDayState['checkIn']>();
const undoCheckIn = vi.fn<MyDayState['undoCheckIn']>();
const readHabit = vi.fn<MyDayState['readHabit']>();
const saveHabit = vi.fn<MyDayState['saveHabit']>();
const openPreview = vi.fn();
let state: MyDayState;
let canUseDailyNotes = true;

vi.mock('../../my-day/use-my-day', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useMyDay: () => state,
}));
vi.mock('../../workspaces/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: WORKSPACE, workspace: { canUseDailyNotes } }),
}));
vi.mock('../../tabs/use-open-item', () => ({
  useOpenItem: () => ({ openPreview, openPinned: vi.fn() }),
}));
vi.mock('../../items/item-dialog-context', () => ({ useItemDialog: () => null }));
vi.mock('../../daily-notes/daily-capture-dialog', () => ({
  DailyCaptureDialog: ({ open }: { open: boolean }) => (open ? <p>capture dialog</p> : null),
}));

const tracker = {
  frequency: 'daily',
  weekdays: [],
  timezone: 'UTC',
  startDate: '2026-10-01',
  target: 20,
  unit: 'minutes',
  reminderTime: null,
} as unknown as HabitTracker;

const complete = { kind: 'complete' as const, reasons: [] };

function task(overrides: Partial<MyDayTaskRow> = {}): MyDayTaskRow {
  return {
    itemId: 'a2222222-2222-4222-8222-222222222222',
    containerId: null,
    containerTitle: 'Inbox',
    title: 'Write report',
    section: 'today',
    dueDay: '2026-10-16',
    startDay: null,
    priority: null,
    estimate: null,
    action: { kind: 'property', key: 'completion', occurredOn: null },
    ...overrides,
  };
}

function habit(overrides: Partial<MyDayHabitRow['occurrence']> = {}): MyDayHabitRow {
  return {
    itemId: 'a3333333-3333-4333-8333-333333333333',
    containerId: null,
    containerTitle: null,
    title: 'Stretch',
    timezone: 'Pacific/Kiritimati',
    occurrence: {
      date: '2026-10-17',
      scheduled: true,
      state: 'scheduled',
      target: 1,
      unit: 'times',
      quantity: null,
      completed: false,
      ...overrides,
    },
  };
}

function day(
  tasks: { rows: MyDayTaskRow[]; coverage?: MyDay['tasks']['coverage'] } = { rows: [task()] },
  habits: MyDayHabitRow[] = [],
): MyDay {
  return {
    workspaceId: WORKSPACE,
    evaluatedAt: '2026-10-16T12:00:00+00:00',
    taskDay: '2026-10-16',
    taskTimezone: 'UTC',
    tasks: {
      rows: tasks.rows,
      coverage: tasks.coverage ?? complete,
      limits: { candidates: 200, rows: 100 },
    },
    habits: { rows: habits, coverage: complete, limits: { candidates: 24, rows: 24 } },
  };
}

function ready(value: MyDay, extra: Partial<MyDayState> = {}): void {
  state = {
    status: 'ready',
    day: value,
    error: null,
    staleReason: null,
    reload: vi.fn(),
    completeTask,
    checkIn,
    undoCheckIn,
    readHabit,
    saveHabit,
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  canUseDailyNotes = true;
  completeTask.mockResolvedValue(null);
  checkIn.mockResolvedValue(null);
  undoCheckIn.mockResolvedValue(null);
  readHabit.mockResolvedValue(tracker);
  saveHabit.mockResolvedValue(null);
});

describe('editing a habit from its row', () => {
  it('opens the saved settings, saves the new name and closes', async () => {
    ready(day({ rows: [] }, [habit()]));
    render(<MyDayPage />);

    await userEvent.click(screen.getByRole('button', { name: 'Edit Stretch' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit habit' });
    expect(readHabit).toHaveBeenCalledWith(expect.objectContaining({ title: 'Stretch' }));
    const name = within(dialog).getByRole('textbox', { name: 'Habit name' });
    expect(name).toHaveValue('Stretch');
    expect(within(dialog).getByRole('spinbutton', { name: /target/i })).toHaveValue(20);

    await userEvent.clear(name);
    await userEvent.type(name, 'New name');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    expect(saveHabit).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Stretch' }),
      'New name',
      expect.objectContaining({ frequency: 'daily', target: 20 }),
    );
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Edit habit' })).not.toBeInTheDocument();
    });
  });

  it('keeps the dialog open and says why when saving fails', async () => {
    ready(day({ rows: [] }, [habit()]));
    saveHabit.mockResolvedValue('No access.');
    render(<MyDayPage />);

    await userEvent.click(screen.getByRole('button', { name: 'Edit Stretch' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit habit' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    expect(await within(dialog).findByText('No access.')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Edit habit' })).toBeInTheDocument();
  });

  it('says why when the settings cannot be read', async () => {
    ready(day({ rows: [] }, [habit()]));
    readHabit.mockResolvedValue('This habit’s settings could not be read.');
    render(<MyDayPage />);

    await userEvent.click(screen.getByRole('button', { name: 'Edit Stretch' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('could not be read');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('the day and zone header', () => {
  it('shows the day and zone the server used, with no instructions', () => {
    ready(day());
    render(<MyDayPage />);
    expect(screen.getByText(/2026-10-16 · UTC/)).not.toHaveTextContent('this device');
  });
});

describe('habit rows', () => {
  const same = { date: '2026-10-16' };
  const named = (title: string, parent: string | null): MyDayHabitRow => ({
    ...habit(same),
    itemId: `${title.padEnd(8, '0')}-0000-4000-8000-000000000000`,
    title,
    containerTitle: parent,
    timezone: 'UTC',
  });

  it('names a parent only when habits come from more than one, and repeats no zone', () => {
    ready(day({ rows: [] }, [named('Walk', 'Health'), named('Read', 'Study')]));
    const { unmount } = render(<MyDayPage />);
    expect(screen.getByText('in Health')).toBeInTheDocument();
    expect(screen.getByText('in Study')).toBeInTheDocument();
    expect(screen.queryByText(/ in UTC/)).not.toBeInTheDocument();
    unmount();

    ready(day({ rows: [] }, [named('Walk', 'Health'), named('Read', 'Health')]));
    render(<MyDayPage />);
    expect(screen.queryByText('in Health')).not.toBeInTheDocument();
  });
});

describe('the My Day page', () => {
  it('names itself while loading and when it failed', () => {
    state = { ...({} as MyDayState), status: 'loading', day: null, error: null, staleReason: null };
    const { rerender } = render(<MyDayPage />);
    expect(screen.getByRole('heading', { name: 'My Day' })).toBeInTheDocument();

    state = { ...state, status: 'error', error: 'My Day could not be loaded.', reload: vi.fn() };
    rerender(<MyDayPage />);
    expect(screen.getByRole('heading', { name: 'My Day' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('My Day could not be loaded.');
  });

  it('groups tasks, labels their source and tells repeating tasks from stored ones', () => {
    ready(
      day({
        rows: [
          task(),
          task({
            itemId: 'a4444444-4444-4444-8444-444444444444',
            title: 'Late invoice',
            section: 'overdue',
            dueDay: '2026-10-01',
          }),
        ],
      }),
    );
    render(<MyDayPage />);

    expect(screen.getByRole('heading', { name: 'Today' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Overdue' })).toBeInTheDocument();
    expect(screen.getAllByText('in Inbox')).toHaveLength(2);
  });

  it('claims an empty day only when the read saw everything', () => {
    ready(day({ rows: [] }));
    const { unmount } = render(<MyDayPage />);
    expect(screen.getByText('Nothing due.')).toBeInTheDocument();
    unmount();

    ready(
      day({
        rows: [],
        coverage: { kind: 'partial', reasons: [{ code: 'candidate_limit', omitted: null }] },
      }),
    );
    render(<MyDayPage />);
    expect(screen.queryByText('Nothing due.')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'More items matched than could be checked',
    );
  });

  it('completes a task through the hook and shows a refusal beside the row', async () => {
    ready(day());
    completeTask.mockResolvedValue('You cannot edit this.');
    render(<MyDayPage />);

    await userEvent.click(screen.getByRole('checkbox', { name: 'Complete Write report' }));

    expect(completeTask).toHaveBeenCalledWith(expect.objectContaining({ title: 'Write report' }));
    expect(await screen.findByText('You cannot edit this.')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Complete Write report' })).not.toBeChecked();
  });

  it('shows a habit’s own day when it differs, and checks in and undoes through the hook', async () => {
    ready(day({ rows: [] }, [habit()]));
    const { unmount } = render(<MyDayPage />);

    expect(screen.getByText('2026-10-17 in Pacific/Kiritimati')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Stretch done' }));
    expect(checkIn).toHaveBeenCalledWith(expect.anything(), { completed: true, quantity: null });
    unmount();

    ready(day({ rows: [] }, [habit({ completed: true })]));
    render(<MyDayPage />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Stretch done' }));
    expect(undoCheckIn).toHaveBeenCalled();
  });

  it('records a counted habit as an absolute quantity', async () => {
    ready(day({ rows: [] }, [habit({ target: 20, unit: 'minutes' })]));
    render(<MyDayPage />);

    await userEvent.type(screen.getByRole('spinbutton', { name: /minutes today/ }), '12');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(checkIn).toHaveBeenCalledWith(expect.anything(), { completed: false, quantity: 12 });
  });

  it('offers capture only where daily notes exist', async () => {
    ready(day());
    const { unmount } = render(<MyDayPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Capture to today’s note' }));
    expect(screen.getByText('capture dialog')).toBeInTheDocument();
    unmount();

    canUseDailyNotes = false;
    render(<MyDayPage />);
    expect(screen.queryByRole('button', { name: /Capture/ })).not.toBeInTheDocument();
  });

  it('opens the original item from its title', async () => {
    ready(day());
    render(<MyDayPage />);

    await userEvent.click(
      within(screen.getByRole('region', { name: 'Tasks' })).getByRole('button', {
        name: 'Open Write report',
      }),
    );

    expect(openPreview).toHaveBeenCalledWith('a2222222-2222-4222-8222-222222222222');
  });
});
