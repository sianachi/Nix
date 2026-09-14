import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HabitChartWidgets } from '../../../views/habit-tracker/habit-chart-widgets';

vi.mock('../../../views/habit-tracker/use-habits', () => ({
  useHabits: () => ({ status: 'ready', trackers: new Map(), error: null, reload: vi.fn() }),
}));

const tracker = {
  habitId: '11111111-1111-4111-8111-111111111111',
  frequency: 'daily' as const,
  weekdays: [],
  timezone: 'UTC',
  startDate: '2026-01-01',
  target: 1,
  unit: 'pages',
  checkIns: [],
  weeks: [],
  status: 'active' as const,
  occurrences: null,
  progress: null,
  months: null,
};

describe('habit chart widgets', () => {
  it('adds a selected chart and edits its date range', () => {
    const onChange = vi.fn();
    render(
      <HabitChartWidgets
        widgets={[]}
        trackers={new Map([[tracker.habitId, tracker]])}
        availableHabits={[{ id: tracker.habitId, title: 'Read' }]}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add chart' }));
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ kind: 'completion', habitId: tracker.habitId }),
    ]);
  });

  it('removes an existing chart and exposes range editing', () => {
    const onChange = vi.fn();
    render(
      <HabitChartWidgets
        widgets={[
          {
            id: 'w1',
            kind: 'quantity',
            habitId: tracker.habitId,
            from: '2026-03-01',
            to: '2026-03-30',
          },
        ]}
        trackers={new Map([[tracker.habitId, tracker]])}
        availableHabits={[{ id: tracker.habitId, title: 'Read' }]}
        onChange={onChange}
      />,
    );
    expect(screen.getByLabelText('From')).toHaveValue('2026-03-01');
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
});
