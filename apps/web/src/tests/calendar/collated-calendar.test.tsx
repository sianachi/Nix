import type { CalendarEntry } from '@nix/api-client';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CollatedCalendar } from '../../calendar/collated-calendar';
import type { CalendarDay } from '../../views/core/calendar-dates';

/**
 * Creating a dated entry from the collated calendar, at the component's own layer.
 *
 * `use-workspace-calendar.test.ts` proves the property a create actually writes is resolved from
 * the chosen container's own view configuration, never from a calendar entry. These tests are about
 * the other half of goal 3.10: what the person is offered, what they are told when nothing
 * qualifies, and what the screen looks like when a create is refused. `onCreate` is a stub here on
 * purpose - this component never resolves a property itself, so nothing it does could leak one from
 * whatever entries happen to be on screen. That is provable from its own type signature:
 * `onCreate(containerId, title, day)` has no property parameter to leak in the first place.
 */

process.env.TZ = 'Pacific/Honolulu';

const CONTAINER_ONE = 'cccccccc-3333-4333-8333-cccccccccccc';
const CONTAINER_TWO = 'dddddddd-4444-4444-8444-dddddddddddd';

const MARCH: CalendarDay = { year: 2026, month: 2, day: 17 };
const APRIL: CalendarDay = { year: 2026, month: 3, day: 5 };

const MARCH_ENTRIES: readonly CalendarEntry[] = [
  {
    itemId: 'a1',
    title: 'Filing deadline',
    containerId: CONTAINER_ONE,
    containerTitle: 'Deadlines',
    dateProperty: 'due',
    value: '2026-03-12',
    kind: 'date',
    // A stored entry, not one a rule produced.
    generated: false,
    completed: null,
  },
  {
    itemId: 'a2',
    title: 'Standup',
    containerId: CONTAINER_TWO,
    containerTitle: 'Sessions',
    dateProperty: 'starts',
    value: '2026-03-17T09:00:00+00:00[Europe/London]',
    kind: 'timestamp',
    // A stored entry, not one a rule produced.
    generated: false,
    completed: null,
  },
];

/** A different window's entries - same containers, a value that would mislead a guess. */
const APRIL_ENTRIES: readonly CalendarEntry[] = [
  {
    itemId: 'b1',
    title: 'Renewal',
    containerId: CONTAINER_ONE,
    containerTitle: 'Deadlines',
    dateProperty: 'due',
    value: '2026-04-09',
    kind: 'date',
    // A stored entry, not one a rule produced.
    generated: false,
    completed: null,
  },
];

function noop(): void {
  // Intentionally does nothing - these props are exercised elsewhere in this suite.
}

function renderCalendar(
  entries: readonly CalendarEntry[],
  anchor: CalendarDay,
  onCreate?: (containerId: string, title: string, day: string) => Promise<string | null>,
): ReturnType<typeof render> {
  return render(
    <CollatedCalendar
      entries={entries}
      grain="month"
      onGrain={noop}
      anchor={anchor}
      onAnchor={noop}
      today={MARCH}
      onOpen={noop}
      onReschedule={noop}
      onCreate={onCreate}
    />,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('offering a destination for a new entry', () => {
  it('offers exactly the notes that placed something, since those are the only ones proven to have a calendar and a date property', async () => {
    renderCalendar(MARCH_ENTRIES, MARCH, () => Promise.resolve(null));

    await userEvent.click(screen.getByRole('button', { name: 'New entry' }));

    const note = screen.getByRole('combobox', { name: 'Note' });
    const options = within(note)
      .getAllByRole('option')
      .map((option) => option.textContent);

    expect(options).toEqual(['Deadlines', 'Sessions']);
  });

  it('says what would make a container eligible, rather than showing an empty menu', () => {
    renderCalendar([], MARCH, () => Promise.resolve(null));

    expect(screen.queryByRole('button', { name: 'New entry' })).not.toBeInTheDocument();
    expect(
      screen.getByText(/no note here offers a calendar with a date property/i),
    ).toBeInTheDocument();
  });

  it('offers no way to create at all when the caller has not wired one', () => {
    renderCalendar(MARCH_ENTRIES, MARCH);

    expect(screen.queryByRole('button', { name: 'New entry' })).not.toBeInTheDocument();
    expect(screen.queryByText(/no note here offers a calendar/i)).not.toBeInTheDocument();
  });
});

describe('creating an entry', () => {
  it('asks for the chosen container, a title and a day - nothing else', async () => {
    const onCreate = vi.fn(() => Promise.resolve(null));
    renderCalendar(MARCH_ENTRIES, MARCH, onCreate);

    await userEvent.click(screen.getByRole('button', { name: 'New entry' }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Note' }), 'Sessions');
    await userEvent.type(screen.getByRole('textbox', { name: 'Title' }), 'Kickoff');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(onCreate).toHaveBeenCalledWith(CONTAINER_TWO, 'Kickoff', '2026-03-17');
  });

  /**
   * The destination must not depend on which month is on screen. Goal 3.10's own words: a page
   * cannot tell what a note places by unless that note happens to have an entry in the window on
   * screen - so this drives the same container through two different windows, one of which carries
   * a value for it that would mislead a guess, and checks the call this component makes carries no
   * property at all for either window to leak through.
   */
  it('does not change what is asked for when the visible month changes', async () => {
    const onCreate = vi.fn(() => Promise.resolve(null));
    const { rerender } = renderCalendar(MARCH_ENTRIES, MARCH, onCreate);

    await userEvent.click(screen.getByRole('button', { name: 'New entry' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Title' }), 'March pick');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(onCreate).toHaveBeenNthCalledWith(1, CONTAINER_ONE, 'March pick', '2026-03-17');

    rerender(
      <CollatedCalendar
        entries={APRIL_ENTRIES}
        grain="month"
        onGrain={noop}
        anchor={APRIL}
        onAnchor={noop}
        today={MARCH}
        onOpen={noop}
        onReschedule={noop}
        onCreate={onCreate}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'New entry' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Title' }), 'April pick');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    // The day tracks where the reader is looking, as it should - only the day, and the same
    // container id both times. There is no property in either call for a window to have coloured.
    expect(onCreate).toHaveBeenNthCalledWith(2, CONTAINER_ONE, 'April pick', '2026-04-05');
  });

  it("shows the service's own words when creation is refused, and draws nothing new", async () => {
    const onCreate = vi.fn(() => Promise.resolve('This note could not be written to right now.'));
    renderCalendar(MARCH_ENTRIES, MARCH, onCreate);

    await userEvent.click(screen.getByRole('button', { name: 'New entry' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Title' }), 'Refused item');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    const alert = await screen.findByRole('alert');
    expect(
      within(alert).getByText(/this note could not be written to right now/i),
    ).toBeInTheDocument();

    // No phantom entry: the grid still shows only the two items the props actually carry.
    expect(screen.getByRole('button', { name: /Filing deadline/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Standup/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Refused item/i })).not.toBeInTheDocument();
  });
});
