import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { YearGrid, yearGridLevel, type YearGridCell } from '../../../views/chart/year-grid';

function nth(list: readonly HTMLElement[], index: number): HTMLElement {
  const element = list[index];
  if (element === undefined) {
    throw new Error(`No element ${String(index)}.`);
  }
  return element;
}

function days(count: number, start = '2026-01-05'): YearGridCell[] {
  const first = Date.parse(`${start}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(first + index * 86_400_000).toISOString().slice(0, 10);
    const value = index % 4;
    return { date, value, label: `${date}: ${String(value)} times` };
  });
}

describe('the year grid', () => {
  it('shades in four steps of the largest value, with nothing as its own step', () => {
    expect(yearGridLevel(null, 8)).toBe(0);
    expect(yearGridLevel(0, 8)).toBe(0);
    expect(yearGridLevel(1, 8)).toBe(1);
    expect(yearGridLevel(2, 8)).toBe(1);
    expect(yearGridLevel(3, 8)).toBe(2);
    expect(yearGridLevel(6, 8)).toBe(3);
    expect(yearGridLevel(8, 8)).toBe(4);
    expect(yearGridLevel(5, 0)).toBe(0);
  });

  it('names every day by its sentence and says the scale in numbers', () => {
    render(<YearGrid cells={days(14)} label="Runs" unit="times" />);

    const grid = screen.getByRole('group', { name: 'Runs' });
    expect(within(grid).getAllByRole('button')).toHaveLength(14);
    expect(within(grid).getByRole('button', { name: '2026-01-06: 1 times' })).toBeVisible();
    expect(screen.getByText(/Four steps up to 3 times/)).toBeVisible();
  });

  it('reads out the focused day and moves by day and by week with the arrow keys', () => {
    render(<YearGrid cells={days(30)} label="Runs" unit="times" />);

    const grid = screen.getByRole('group', { name: 'Runs' });
    const buttons = within(grid).getAllByRole('button');

    // One tab stop: the latest day, until somebody moves.
    expect(buttons.filter((button) => button.tabIndex === 0)).toHaveLength(1);
    expect(buttons.at(-1)?.tabIndex).toBe(0);

    fireEvent.focus(nth(buttons, 0));
    expect(screen.getByText('2026-01-05: 0 times')).toBeVisible();

    fireEvent.keyDown(nth(buttons, 0), { key: 'ArrowRight' });
    expect(buttons[7]).toHaveFocus();
    expect(screen.getByText('2026-01-12: 3 times')).toBeVisible();

    fireEvent.keyDown(nth(buttons, 7), { key: 'ArrowDown' });
    expect(buttons[8]).toHaveFocus();

    fireEvent.keyDown(nth(buttons, 8), { key: 'End' });
    expect(buttons.at(-1)).toHaveFocus();
  });

  it('starts its first column on the right weekday', () => {
    // 2026-01-07 is a Wednesday: two empty cells above it, Monday and Tuesday.
    const { container } = render(
      <YearGrid cells={days(3, '2026-01-07')} label="Runs" unit="times" />,
    );

    const grid = container.querySelector('[role="group"]');
    expect(grid?.querySelectorAll('span[aria-hidden="true"]')).toHaveLength(2);
  });

  it('reports a chosen day', () => {
    const onSelect = vi.fn();
    render(
      <YearGrid
        cells={days(7)}
        label="Runs"
        unit="times"
        onSelect={onSelect}
        selected="2026-01-06"
      />,
    );

    expect(screen.getByRole('button', { name: '2026-01-06: 1 times' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: '2026-01-08: 3 times' }));
    expect(onSelect).toHaveBeenCalledWith('2026-01-08');
  });
});
