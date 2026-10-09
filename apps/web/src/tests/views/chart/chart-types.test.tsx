import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ChartBody } from '../../../views/chart/chart-view';
import { aChart, aSplitChart, aTimeChart, aYearChart } from './chart-fixtures';

/**
 * Every chart type is also a table.
 *
 * The drawings are decoration: these assertions are about the figures being in the markup as text,
 * which is what a screen reader reads and what a copy carries, whatever the drawing looks like.
 */
describe('every chart type', () => {
  it.each(['column', 'pie', 'line', 'area'])(
    'draws a %s chart above a table holding every figure',
    (chartKind) => {
      const { container } = render(<ChartBody chart={aChart({ chartKind })} />);

      const table = screen.getByRole('table');
      expect(within(table).getByRole('row', { name: /todo/i })).toHaveTextContent('6');
      expect(within(table).getByRole('row', { name: /unset/i })).toHaveTextContent('1');

      // The drawing is there, and it is hidden from assistive technology.
      const drawing = container.querySelector('svg');
      expect(drawing).not.toBeNull();
      expect(drawing?.closest('[aria-hidden="true"]')).not.toBeNull();
    },
  );

  it('draws a type this build does not know as bars rather than nothing', () => {
    render(<ChartBody chart={aChart({ chartKind: 'radar' })} />);

    expect(screen.getByRole('row', { name: /todo/i })).toHaveTextContent('6');
  });

  it('gives a pie each slice its share as text', () => {
    render(<ChartBody chart={aChart({ chartKind: 'pie' })} />);

    expect(screen.getByRole('columnheader', { name: 'Share (%)' })).toBeVisible();
    expect(screen.getByRole('row', { name: /todo/i })).toHaveTextContent('60');
  });

  it('labels a time axis by its periods, earliest first', () => {
    render(<ChartBody chart={aTimeChart()} />);

    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(12);
    expect(rows[0]).toHaveTextContent(/Jan 2026/);
    expect(rows[2]).toHaveTextContent('0');
  });

  it('puts the running total and the trailing average in the table when they are drawn', () => {
    render(<ChartBody chart={aTimeChart()} cumulative rollingAverage />);

    expect(screen.getByRole('columnheader', { name: 'Items (running total)' })).toBeVisible();
    expect(
      screen.getByRole('columnheader', { name: 'Items (running total) (7-period average)' }),
    ).toBeVisible();
    // 1 + 2 + 0 + 4 + 5 + 3 + 2 + 6 + 1 + 0 + 4 + 2 = 30, the last running total.
    expect(screen.getAllByRole('row').at(-1)).toHaveTextContent('30');
  });

  it('ignores the line toggles on a type that has no line', () => {
    render(<ChartBody chart={aTimeChart({ chartKind: 'column' })} cumulative rollingAverage />);

    expect(screen.queryByRole('columnheader', { name: /running total/ })).toBeNull();
  });

  it('gives each series a column and a legend entry, and can stand them side by side', () => {
    render(<ChartBody chart={aSplitChart()} />);

    expect(screen.getByRole('columnheader', { name: 'Ada' })).toBeVisible();
    expect(screen.getByRole('columnheader', { name: 'All' })).toBeVisible();
    expect(within(screen.getByRole('list', { name: 'Legend' })).getByText('Ada')).toBeVisible();

    const todo = screen.getByRole('row', { name: /todo/i });
    expect(
      within(todo)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['4', '2', '6']);

    fireEvent.click(screen.getByRole('button', { name: 'Side by side' }));
    expect(screen.getByRole('button', { name: 'Side by side' })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('splits the bars of a bar chart into series with their own figures', () => {
    render(<ChartBody chart={aSplitChart({ chartKind: 'bar' })} />);

    const done = screen.getByRole('row', { name: /done/i });
    expect(
      within(done)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['1', '2', '3']);
  });

  it('draws a year grid whose days are named by their values, with the table behind a disclosure', () => {
    render(<ChartBody chart={aYearChart()} />);

    const grid = screen.getByRole('group', { name: /how many items per day/i });
    expect(within(grid).getAllByRole('button')).toHaveLength(371);
    expect(within(grid).getByRole('button', { name: /6 Oct 2025: 1 items/ })).toBeVisible();
    expect(screen.getByText('Every day as a table')).toBeVisible();
  });

  it('says when no item falls in the periods a windowed chart shows', () => {
    render(
      <ChartBody
        chart={aTimeChart({
          buckets: [{ value: '2026-01-01', children: 0, total: null }],
          children: 0,
          unplaced: 2,
        })}
      />,
    );

    expect(screen.getByText(/No items fall in the periods this chart shows/)).toBeVisible();
    expect(screen.getByText(/2 items have no date/)).toBeVisible();
  });
});
