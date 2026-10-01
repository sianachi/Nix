import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderAt } from '../../render-with-router';
import { aContainer, views } from '../../container-fixture';
import { aView } from '../../view-fixture';
import { BoardView } from '../../../views/board/board-view';
import type { Item, PropertyDefinition } from '../../../views/core/container-model';
import { clearSuggestionDismissals } from '../../../lib/suggestion-dismissals';
import { useViewSuggestionPreference } from '../../../settings/suggestion-preferences';
import { anItem, memoryStorage } from '../suggest/suggest-fixtures';

/**
 * The board's stale-card note: said only for a card far older than its column's usual, phrased as
 * "unchanged" because `updatedAt` is the only clock there is, and gone when waved away.
 */

const STATUS: PropertyDefinition = {
  key: 'status',
  label: 'Status',
  type: 'select',
  options: ['Doing', 'Done'],
  required: false,
};

const DAY = 24 * 60 * 60 * 1000;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY).toISOString();
}

function cards(ages: readonly number[]): Item[] {
  return ages.map((days, index) =>
    anItem(`Card ${String(index + 1)}`, { status: 'Doing' }, { updatedAt: daysAgo(days) }),
  );
}

function renderBoard(ages: readonly number[] | readonly Item[]) {
  const children = typeof ages[0] === 'number' ? cards(ages as number[]) : (ages as Item[]);
  return renderAt(
    <BoardView
      container={aContainer({
        schema: { properties: [STATUS], declared: [STATUS], inherit: true },
        views: views([]),
        children,
      })}
      view={aView({ kind: 'board', groupBy: 'status' })}
      onOpen={vi.fn()}
    />,
  );
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  clearSuggestionDismissals();
  useViewSuggestionPreference.getState().setSetting('on');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the stale card note', () => {
  it('points out a card untouched far longer than its column usually is', () => {
    renderBoard([1, 1.5, 1.5, 2, 30]);

    const notes = screen.getAllByText(/No changes in/);
    expect(notes).toHaveLength(1);
    // The column median is a day and a half; it is rounded up, never down, so the sentence
    // does not claim the column moves faster than it does.
    expect(notes[0]).toHaveTextContent(
      'No changes in 30 days. Half the cards in Doing changed in the last 2 days.',
    );
  });

  it('stays quiet when the whole column moves at the same pace', () => {
    renderBoard([20, 21, 22, 25]);
    expect(screen.queryByText(/No changes in/)).not.toBeInTheDocument();
  });

  it('goes away when dismissed', () => {
    renderBoard([1, 2, 2, 3, 30]);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss the stale card note on Card 5' }));
    expect(screen.queryByText(/No changes in/)).not.toBeInTheDocument();
  });

  it('stays dismissed when the board is opened again', () => {
    const children = cards([1, 2, 2, 3, 30]);
    const first = renderBoard(children);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss the stale card note on Card 5' }));
    first.unmount();

    renderBoard(children);

    expect(screen.queryByText(/No changes in/)).not.toBeInTheDocument();
  });

  it('comes back once the card has changed and gone stale again', () => {
    const children = cards([1, 2, 2, 3, 30]);
    const first = renderBoard(children);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss the stale card note on Card 5' }));
    first.unmount();

    const edited = children.map((item, index) =>
      index === 4 ? { ...item, updatedAt: daysAgo(29) } : item,
    );
    renderBoard(edited);

    expect(screen.getByText(/No changes in/)).toHaveTextContent('No changes in 29 days.');
  });

  it('is not shown when suggestions in views are switched off', () => {
    useViewSuggestionPreference.getState().setSetting('off');
    renderBoard([1, 2, 2, 3, 30]);
    expect(screen.queryByText(/No changes in/)).not.toBeInTheDocument();
  });
});
