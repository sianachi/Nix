import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderAt } from '../test/render-with-router';
import { CalendarView } from './calendar-view';
import type { EffectiveSchema, Item, View } from './container-model';
import { aContainer, views } from './container-fixture';
import type { ContainerData } from './use-container';

/**
 * The calendar, driven the way a person drives it.
 *
 * **The whole suite runs ten hours west of UTC, on purpose.** Placement bugs in calendars are
 * timezone bugs: `new Date('2026-03-01')` is UTC midnight, and in Honolulu that is the afternoon of
 * the 28th of February. A suite that runs in UTC cannot tell a calendar that compares date text
 * from one that quietly shifts every item back a day for half the world, because in UTC the two
 * behave identically. Running here means every assertion below is also an assertion that no stored
 * date was turned into an instant.
 */
process.env.TZ = 'Pacific/Honolulu';

const SCHEMA: EffectiveSchema = {
  properties: [
    { key: 'due', label: 'Due', type: 'date', options: [], required: false },
    {
      key: 'status',
      label: 'Status',
      type: 'select',
      options: ['open', 'blocked'],
      required: false,
    },
  ],
  declared: [],
  inherit: true,
};

const VIEW: View = {
  id: 'view-schedule',
  name: 'Schedule',
  kind: 'calendar',
  columns: ['title', 'status'],
  groupBy: null,
  groupOrder: [],
  dateProperty: 'due',
  sortBy: null,
  sortDescending: false,
};

function itemOf(id: string, title: string, properties: Record<string, unknown>): Item {
  return {
    id,
    workspaceId: 'a1000000-0000-4000-8000-000000000001',
    parentId: 'folder-1',
    type: 'note',
    title,
    seq: 1000,
    lifecycleState: 'active',
    properties,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

const KICKOFF = itemOf('item-kickoff', 'Kickoff', { due: '2026-03-17', status: 'open' });

function containerOf(overrides: Partial<ContainerData> = {}): ContainerData {
  return aContainer({
    schema: SCHEMA,
    views: views([VIEW]),
    setProperties: vi.fn(() => Promise.resolve()),
    reload: vi.fn(() => Promise.resolve()),
    ...overrides,
  });
}

interface RenderOptions {
  readonly view?: View;
  readonly url?: string;
}

function renderCalendar(container: Partial<ContainerData> = {}, options: RenderOptions = {}) {
  const onOpen = vi.fn();
  const data = containerOf(container);

  renderAt(
    <CalendarView container={data} view={options.view ?? VIEW} onOpen={onOpen} />,
    options.url ?? '/',
  );

  return { onOpen, setProperties: data.setProperties };
}

beforeEach(() => {
  // Pinned to a Sunday in the middle of March 2026, so "which month opens" is a fact rather than a
  // property of the day the suite happens to run. Constructed from local parts, never from a
  // string: a parsed instant would be a different day here than on a CI box in UTC.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 2, 15, 12, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

function user() {
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
}

describe('the calendar view', () => {
  it('places an item on the day its date property names', () => {
    renderCalendar({ children: [KICKOFF] });

    const day = screen.getByRole('cell', { name: 'Tuesday 17 March 2026' });
    expect(within(day).getByRole('button', { name: 'Kickoff' })).toBeVisible();
  });

  it('opens on the month containing today and names it', () => {
    renderCalendar({ children: [KICKOFF] });

    expect(screen.getByRole('heading', { name: 'March 2026' })).toBeVisible();
  });

  it('places the first of the month on the first of the month, not on the last day of the one before', () => {
    // Proof that this environment would punish a date turned into an instant: parsed as UTC
    // midnight and read back locally, the first of March is the twenty-eighth of February.
    expect(new Date('2026-03-01').getDate()).toBe(28);
    expect(new Date('2026-03-01').getMonth()).toBe(1);

    renderCalendar({
      children: [itemOf('item-launch', 'Launch', { due: '2026-03-01', status: 'open' })],
    });

    const first = screen.getByRole('cell', { name: 'Sunday 1 March 2026' });
    expect(within(first).getByRole('button', { name: 'Launch' })).toBeVisible();

    // And it has not leaked into a February the March grid does not even have.
    expect(screen.queryByRole('cell', { name: /february/i })).not.toBeInTheDocument();
  });

  it('lists an item with no date as unscheduled rather than dropping it', () => {
    renderCalendar({
      children: [KICKOFF, itemOf('item-someday', 'Someday', { status: 'open' })],
    });

    const unscheduled = screen.getByRole('region', { name: /unscheduled/i });
    expect(within(unscheduled).getByRole('button', { name: 'Someday' })).toBeVisible();
  });

  it('treats a value that is not a date as unscheduled rather than guessing a day for it', () => {
    renderCalendar({
      children: [itemOf('item-vague', 'Vague', { due: 'next week', status: 'open' })],
    });

    const unscheduled = screen.getByRole('region', { name: /unscheduled/i });
    expect(within(unscheduled).getByRole('button', { name: 'Vague' })).toBeVisible();
  });

  it('says how many items are dated outside the month on screen', () => {
    renderCalendar({
      children: [KICKOFF, itemOf('item-later', 'Later', { due: '2026-09-02', status: 'open' })],
    });

    expect(screen.getByRole('status')).toHaveTextContent('1 item is dated outside March 2026.');
  });

  it('moves to the next month and back again', async () => {
    const person = user();
    renderCalendar({
      children: [itemOf('item-review', 'Review', { due: '2026-04-02', status: 'open' })],
    });

    expect(screen.queryByRole('button', { name: 'Review' })).not.toBeInTheDocument();

    await person.click(screen.getByRole('button', { name: 'Next month' }));

    expect(screen.getByRole('heading', { name: 'April 2026' })).toBeVisible();
    const day = screen.getByRole('cell', { name: 'Thursday 2 April 2026' });
    expect(within(day).getByRole('button', { name: 'Review' })).toBeVisible();

    await person.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(screen.getByRole('heading', { name: 'March 2026' })).toBeVisible();
  });

  it('crosses a year boundary rather than stopping at December', async () => {
    const person = user();
    renderCalendar({ children: [KICKOFF] });

    for (let step = 0; step < 10; step += 1) {
      await person.click(screen.getByRole('button', { name: 'Next month' }));
    }

    expect(screen.getByRole('heading', { name: 'January 2027' })).toBeVisible();
  });

  it('returns to the current month when today is asked for', async () => {
    const person = user();
    renderCalendar({ children: [KICKOFF] });

    await person.click(screen.getByRole('button', { name: 'Next month' }));
    await person.click(screen.getByRole('button', { name: 'Today' }));

    expect(screen.getByRole('heading', { name: 'March 2026' })).toBeVisible();
  });

  it('reschedules an item from the keyboard, writing the day the person named', async () => {
    const person = user();
    const { setProperties } = renderCalendar({ children: [KICKOFF] });

    await person.click(screen.getByRole('button', { name: 'Reschedule Kickoff' }));
    await person.type(screen.getByLabelText('New date for Kickoff'), '2026-03-20');
    await person.click(screen.getByRole('button', { name: 'Move' }));

    expect(setProperties).toHaveBeenCalledWith('item-kickoff', { due: '2026-03-20' });
  });

  it('takes a date off an item from the keyboard, so the mouse has no gesture the keyboard lacks', async () => {
    const person = user();
    const { setProperties } = renderCalendar({ children: [KICKOFF] });

    await person.click(screen.getByRole('button', { name: 'Reschedule Kickoff' }));
    await person.click(screen.getByRole('button', { name: 'Remove date' }));

    expect(setProperties).toHaveBeenCalledWith('item-kickoff', { due: null });
  });

  it('refuses an incomplete date rather than sending it to be rejected', async () => {
    const person = user();
    const { setProperties } = renderCalendar({ children: [KICKOFF] });

    await person.click(screen.getByRole('button', { name: 'Reschedule Kickoff' }));
    await person.click(screen.getByRole('button', { name: 'Move' }));

    expect(setProperties).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a date as year, month and day.');
  });

  it('writes the date property when a card is dropped on a day', () => {
    const { setProperties } = renderCalendar({ children: [KICKOFF] });

    const dataTransfer = { effectAllowed: '', setData: vi.fn(), getData: vi.fn() };
    fireEvent.dragStart(screen.getByRole('button', { name: 'Kickoff' }), { dataTransfer });
    fireEvent.drop(screen.getByRole('cell', { name: 'Friday 27 March 2026' }), { dataTransfer });

    expect(setProperties).toHaveBeenCalledWith('item-kickoff', { due: '2026-03-27' });
  });

  it('surfaces a refused write instead of swallowing it, and keeps the calendar on screen', () => {
    renderCalendar({
      children: [KICKOFF],
      writeError: 'You do not have permission to change this item.',
    });

    expect(screen.getByRole('alert')).toHaveTextContent(
      'You do not have permission to change this item.',
    );
    expect(screen.getByRole('button', { name: 'Kickoff' })).toBeVisible();
  });

  it('opens an item when its card is clicked', async () => {
    const person = user();
    const { onOpen } = renderCalendar({ children: [KICKOFF] });

    await person.click(screen.getByRole('button', { name: 'Kickoff' }));

    expect(onOpen).toHaveBeenCalledWith('item-kickoff');
  });

  it('says the folder is empty when it is empty', () => {
    renderCalendar({ children: [] });

    expect(screen.getByRole('status')).toHaveTextContent('This folder is empty');
  });

  it('says the filters hide everything, which is not the same as an empty folder', () => {
    renderCalendar({ children: [KICKOFF] }, { url: '/?f.status=blocked' });

    const panel = screen.getByRole('status');
    expect(panel).toHaveTextContent('No items match the current filters');
    expect(panel).not.toHaveTextContent('This folder is empty');
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeVisible();
  });

  it('explains that it cannot be drawn when its date property is gone from the schema', () => {
    renderCalendar({ children: [KICKOFF] }, { view: { ...VIEW, dateProperty: 'delivered' } });

    // Not an empty month: an empty calendar and a broken calendar look identical if you let them.
    expect(screen.getByRole('alert')).toHaveTextContent('that property is not in this folder');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('explains that it cannot be drawn when its date property is not a date', () => {
    renderCalendar({ children: [KICKOFF] }, { view: { ...VIEW, dateProperty: 'status' } });

    expect(screen.getByRole('alert')).toHaveTextContent(
      'which is a select property rather than a date',
    );
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('explains that it cannot be drawn when the view names no date property at all', () => {
    renderCalendar({ children: [KICKOFF] }, { view: { ...VIEW, dateProperty: null } });

    expect(screen.getByRole('alert')).toHaveTextContent(
      'A calendar places items by a date property, and this view does not name one.',
    );
  });

  it('believes Core when it says the view can no longer be drawn', () => {
    renderCalendar({
      children: [KICKOFF],
      views: { views: [VIEW], unrenderable: [VIEW.id], default: 'document' },
    });

    expect(screen.getByRole('alert')).toHaveTextContent('can no longer be drawn');
  });

  it('says it is loading rather than showing an empty month', () => {
    renderCalendar({ status: 'loading' });

    expect(screen.getByText('Loading this calendar')).toBeVisible();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('says a failed load failed, and offers a retry', () => {
    renderCalendar({ status: 'error', error: 'Core could not be reached.' });

    expect(screen.getByRole('alert')).toHaveTextContent('Core could not be reached.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  it('gives every day of the month a name a screen reader can announce', () => {
    renderCalendar({ children: [KICKOFF] });

    // March 2026 begins on a Sunday and has thirty-one days, so both ends of the month have to be
    // reachable and correctly named for the grid arithmetic to be right.
    expect(screen.getByRole('cell', { name: 'Sunday 1 March 2026' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Tuesday 31 March 2026' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Monday' })).toBeInTheDocument();
  });

  it('counts February 2028 as a leap February', async () => {
    const person = user();
    renderCalendar({ children: [KICKOFF] });

    for (let step = 0; step < 23; step += 1) {
      await person.click(screen.getByRole('button', { name: 'Next month' }));
    }

    expect(screen.getByRole('heading', { name: 'February 2028' })).toBeVisible();
    expect(screen.getByRole('cell', { name: 'Tuesday 29 February 2028' })).toBeInTheDocument();
  });
});
