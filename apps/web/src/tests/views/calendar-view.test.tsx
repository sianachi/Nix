import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderAt } from '../render-with-router';
import { aView } from '../view-fixture';
import { VIEW_GUTTER_BLEED } from '../../views/container-view';
import { CalendarView } from '../../views/calendar-view';
import type { EffectiveSchema, Item, View } from '../../views/container-model';
import { aContainer, views } from '../../views/container-fixture';
import type { ContainerData } from '../../views/use-container';

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

const VIEW: View = aView({
  id: 'view-schedule',
  name: 'Schedule',
  kind: 'calendar',
  columns: ['title', 'status'],
  dateProperty: 'due',
});

function itemOf(id: string, title: string, properties: Record<string, unknown>): Item {
  return {
    id,
    workspaceId: 'a1000000-0000-4000-8000-000000000001',
    parentId: 'folder-1',
    type: 'note',
    title,
    hasChildren: false,
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
    setProperties: vi.fn(() => Promise.resolve(null)),
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
    // Opened on the boundary itself rather than walked to it: the calendar takes its opening month
    // from the clock, so naming December is both cheaper and clearer than ten clicks whose only
    // proof that they land on December is that somebody counted them correctly.
    vi.setSystemTime(new Date(2026, 11, 15, 12, 0, 0));

    const person = user();
    renderCalendar({ children: [KICKOFF] });

    // The step across the boundary is the behaviour under test, so it stays a real click.
    await person.click(screen.getByRole('button', { name: 'Next month' }));

    expect(screen.getByRole('heading', { name: 'January 2027' })).toBeVisible();
  });

  it('returns to the current month when today is asked for', async () => {
    const person = user();
    renderCalendar({ children: [KICKOFF] });

    await person.click(screen.getByRole('button', { name: 'Next month' }));
    await person.click(screen.getByRole('button', { name: 'Today' }));

    expect(screen.getByRole('heading', { name: 'March 2026' })).toBeVisible();
  });

  it('opens rescheduling as a dialog that shows the date the item has now', async () => {
    // A dialog rather than a form swapped into the card's place: the month cell is a `w-[6.5rem]`
    // column, and a native date input needs roughly 120px to draw its value, so the inline form
    // rendered a control that could not show the date being edited.
    const person = user();
    renderCalendar({ children: [KICKOFF] });

    await person.click(screen.getByRole('button', { name: 'Reschedule Kickoff' }));

    const dialog = screen.getByRole('dialog', { name: 'Reschedule Kickoff' });
    expect(within(dialog).getByLabelText('New date for Kickoff')).toHaveValue('2026-03-17');
  });

  it('reschedules an item from the keyboard, writing the day the person named', async () => {
    const person = user();
    const { setProperties } = renderCalendar({ children: [KICKOFF] });

    await person.click(screen.getByRole('button', { name: 'Reschedule Kickoff' }));

    const field = screen.getByLabelText('New date for Kickoff');
    await person.clear(field);
    await person.type(field, '2026-03-20');
    await person.click(screen.getByRole('button', { name: 'Move' }));

    expect(setProperties).toHaveBeenCalledWith('item-kickoff', { due: '2026-03-20' });
  });

  it('closes the reschedule dialog when the platform reports Escape, and writes nothing', async () => {
    const person = user();
    const { setProperties } = renderCalendar({ children: [KICKOFF] });

    await person.click(screen.getByRole('button', { name: 'Reschedule Kickoff' }));

    // Escape reaches a modal <dialog> as a cancellable `cancel` event; jsdom does not translate
    // the key itself, so the event is dispatched the way Dialog.test.tsx's own pressEscape does.
    const dialog = screen.getByRole('dialog', { name: 'Reschedule Kickoff' });
    fireEvent(dialog, new Event('cancel', { cancelable: true }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(setProperties).not.toHaveBeenCalled();
  });

  it('keeps the Escape press inside the dialog instead of letting outer layers see it', async () => {
    // ADR-0029's layering rule: the innermost open layer owns Escape. A window-level listener -
    // the sidebar drawer's - must never receive the same press that closed this dialog, or one
    // key would close two things at once.
    const person = user();
    renderCalendar({ children: [KICKOFF] });

    await person.click(screen.getByRole('button', { name: 'Reschedule Kickoff' }));

    const seenByWindow = vi.fn();
    window.addEventListener('keydown', seenByWindow);
    try {
      fireEvent.keyDown(screen.getByLabelText('New date for Kickoff'), { key: 'Escape' });
      expect(seenByWindow).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', seenByWindow);
    }
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

    // The field opens holding the item's current date, so the incomplete draft has to be made:
    // emptied, the way somebody who cleared the value and pressed Move would leave it.
    await person.clear(screen.getByLabelText('New date for Kickoff'));
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

  it('says there is nothing here when there is nothing here', () => {
    renderCalendar({ children: [] });

    expect(screen.getByRole('status')).toHaveTextContent('Nothing in here yet');
  });

  it('says the filters hide everything, which is not the same as an empty folder', () => {
    renderCalendar({ children: [KICKOFF] }, { url: '/?f.status=blocked' });

    const panel = screen.getByRole('status');
    expect(panel).toHaveTextContent('No items match the current filters');
    expect(panel).not.toHaveTextContent('Nothing in here yet');
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeVisible();
  });

  it('explains that it cannot be drawn when its date property is gone from the schema', () => {
    renderCalendar({ children: [KICKOFF] }, { view: { ...VIEW, dateProperty: 'delivered' } });

    // Not an empty month: an empty calendar and a broken calendar look identical if you let them.
    expect(screen.getByRole('alert')).toHaveTextContent('that property is not in this item');
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

  it('counts February 2028 as a leap February', () => {
    // What is under test is the grid the calendar draws for a leap February, not the route taken to
    // reach one. The month it opens on comes from the clock - the same lever 'opens on the month
    // containing today' uses - so the month is named here rather than walked to.
    vi.setSystemTime(new Date(2028, 1, 15, 12, 0, 0));

    renderCalendar({ children: [KICKOFF] });

    expect(screen.getByRole('heading', { name: 'February 2028' })).toBeVisible();
    expect(screen.getByRole('cell', { name: 'Tuesday 29 February 2028' })).toBeInTheDocument();
  });

  it('creates an item already dated to the day it was added on', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const create = vi.fn(() => Promise.resolve(null));

    renderAt(
      <CalendarView
        container={containerOf({ children: [KICKOFF], create })}
        view={VIEW}
        onOpen={vi.fn()}
      />,
    );

    const day = screen.getByRole('cell', { name: 'Friday 27 March 2026' });
    await user.click(within(day).getByRole('button', { name: /add an item on friday 27 march/i }));
    await user.type(
      screen.getByRole('textbox', { name: /add an item on friday 27 march/i }),
      'Retro{Enter}',
    );

    // The same write a drop onto that day makes. Written as text, never as an instant - the suite
    // runs ten hours west of UTC precisely so a date turned into a moment would land on the 26th.
    expect(create).toHaveBeenCalledWith('Retro', { due: '2026-03-27' });
  });

  describe('the month grid at a narrow width', () => {
    /**
     * The month grid's own width floor: a real `<table>` with `table-layout: fixed`, which takes
     * its column widths from the header row alone. Below, `MONTH_DAY_COLUMN` and
     * `MONTH_GRID_MIN_WIDTH` in calendar-view.tsx.
     *
     * **What this cannot prove.** jsdom performs no layout - every element is zero by zero, nothing
     * overflows anything, and there is no scrollbar to measure - so nothing here can show that
     * seven 6.5rem columns actually push the table past a 375px viewport, or that `Blueprint`'s
     * `overflow-x-auto` visibly takes over once they do. That is a claim about rendered layout,
     * which belongs in a browser-based pass (Storybook + axe, U10), not a jsdom one; see
     * `calendar-hours.test.tsx`'s own note on the same limit. What is checkable, and what this
     * checks, is the class contract: the table's own floor and each column's floor are each spelled
     * out as Tailwind classes, and those classes are either present on the right element or they
     * are not.
     */
    it('gives the table a floor no viewport can squeeze it under', () => {
      renderCalendar({ children: [KICKOFF] });

      expect(screen.getByRole('table')).toHaveClass('min-w-[45.5rem]', 'table-fixed');
    });

    it('gives every weekday column its own floor width, so table-fixed cannot divide it away', () => {
      renderCalendar({ children: [KICKOFF] });

      for (const name of [
        'Monday',
        'Tuesday',
        'Wednesday',
        'Thursday',
        'Friday',
        'Saturday',
        'Sunday',
      ]) {
        expect(screen.getByRole('columnheader', { name })).toHaveClass('w-[6.5rem]');
      }
    });

    it('scrolls the table through a region a keyboard can reach without a pointer', () => {
      renderCalendar({ children: [KICKOFF] });

      // `overflow-x-auto` is the class the whole fix actually depends on: without it, a table
      // wider than its frame would simply overflow the page rather than scroll inside it - see
      // calendar-view.tsx's own comment on why the width floor and the scroller are two different
      // classes doing two different jobs.
      const region = screen.getByRole('region', { name: /march 2026/i });
      expect(region).toHaveClass('overflow-x-auto');
      expect(region).toHaveAttribute('tabIndex', '0');
      expect(screen.getByRole('table').closest('.overflow-x-auto')).toBe(region);
    });

    it('bleeds the container gutter into the scroller so the last column never clips under the frame', () => {
      renderCalendar({ children: [KICKOFF] });

      // The arithmetic this contract stands for (jsdom does no layout, so it cannot be measured
      // here): the table's floor is 728px, and the frame's border (2px), its p-3 (24px) and
      // ContainerView's px-8 gutter (64px) stand around it - so with the scroller inside the
      // frame, a container between ~750 and ~790px wide clipped the last column under the frame's
      // right border before scrolling visibly engaged. `VIEW_GUTTER_BLEED` on the region hands the
      // gutter's 64px to the scroll viewport while the padding keeps the resting position exactly
      // where the header and switcher align; `min-w-max` on the frame makes it travel with the
      // table so the last column ends at the frame's edge rather than under it.
      //
      // Asserted against the exported constants rather than against `-mx-8 px-8` spelled out
      // again: the gutter's width is container-view.tsx's to decide, and a test that pinned the
      // literal would be a third place encoding "8" and the first one to fail for the wrong
      // reason when the gutter changes.
      const region = screen.getByRole('region', { name: /march 2026/i });
      expect(region).toHaveClass(...VIEW_GUTTER_BLEED.split(' '), 'overflow-x-auto');

      const frame = screen.getByRole('table').closest('.border-divider');
      expect(frame).toBeInstanceOf(HTMLElement);
      expect(frame).toHaveClass('min-w-max');
      expect(region.contains(frame)).toBe(true);
    });
  });
});

describe('the day cell create control by keyboard', () => {
  // The control is hidden until hover with `opacity-0`/`pointer-events-none`, deliberately not
  // `invisible`: `visibility: hidden` removes an element from the tab order entirely, so a focus
  // reveal could never fire - nothing could tab to the control in order to un-hide it. See the
  // cell's own comment in calendar-view.tsx.
  //
  // **What the class assertion cannot show.** jsdom applies no stylesheet, so
  // `toHaveClass('focus-visible:opacity-100')` proves a string is present on the element and
  // nothing more - a mistyped variant, or one Tailwind never generated, passes it just the same.
  // That the control actually becomes visible on focus is on the owed real-browser/Storybook
  // list. What *is* proven here is the half that matters most for the keyboard: the control is a
  // real tab stop and operating it needs no pointer.

  it('carries the reveal contract without reaching for visibility hidden', () => {
    renderCalendar({ children: [KICKOFF] });

    const control = screen.getByRole('button', { name: 'Add an item on Tuesday 17 March 2026' });
    expect(control).toHaveClass(
      'opacity-0',
      'pointer-events-none',
      'focus-visible:opacity-100',
      'focus-visible:pointer-events-auto',
    );
    expect(control.className).not.toContain('invisible');
  });

  it('is reachable by tabbing rather than existing only for a pointer', async () => {
    renderCalendar({ children: [KICKOFF] });

    // Tabbed to from the item inside the same cell, rather than focused by hand: `.focus()`
    // succeeds on elements Tab can never reach, so it cannot tell a keyboard-reachable control
    // from an unreachable one - which is the entire claim being made here.
    screen.getByRole('button', { name: 'Kickoff' }).focus();
    await user().tab();
    await user().tab();

    expect(
      screen.getByRole('button', { name: 'Add an item on Tuesday 17 March 2026' }),
    ).toHaveFocus();
  });

  it('opens its naming field with the keyboard alone', async () => {
    renderCalendar({ children: [KICKOFF] });

    screen.getByRole('button', { name: 'Add an item on Tuesday 17 March 2026' }).focus();
    await user().keyboard('{Enter}');

    expect(
      screen.getByRole('textbox', { name: 'Add an item on Tuesday 17 March 2026' }),
    ).toHaveFocus();
  });
});

/**
 * Scheduling by dropping onto an hour, which is the gesture a week view exists for.
 *
 * These run against a `timestamp` property rather than the `date` the rest of the suite uses,
 * because an hour is a thing only a moment can carry. Still ten hours west of UTC: a slot writes a
 * wall clock in the reader's zone, so every assertion here is also an assertion that the offset was
 * derived rather than assumed.
 */
describe('dropping an unscheduled item onto an hour', () => {
  const TIMED_SCHEMA: EffectiveSchema = {
    properties: [
      { key: 'starts', label: 'Starts', type: 'timestamp', options: [], required: false },
    ],
    declared: [],
    inherit: true,
  };

  const WEEK: View = aView({
    id: 'view-week',
    name: 'This week',
    kind: 'calendar',
    columns: ['title'],
    dateProperty: 'starts',
    mode: 'week',
  });

  const LOOSE = itemOf('item-loose', 'Loose end', {});

  function renderWeek(children: readonly Item[]) {
    const onOpen = vi.fn();
    const data = aContainer({
      schema: TIMED_SCHEMA,
      views: views([WEEK]),
      setProperties: vi.fn(() => Promise.resolve(null)),
      reload: vi.fn(() => Promise.resolve()),
      children: [...children],
    });

    renderAt(<CalendarView container={data} view={WEEK} onOpen={onOpen} />, '/');

    return { setProperties: data.setProperties };
  }

  /**
   * The slot itself carries no role and no name, and deliberately: 168 named empty cells would be
   * 168 things a screen reader has to walk past to reach the grid's content. It is found through
   * the create control it holds, then up to the element the roving grid already marks as a cell -
   * an existing structural hook rather than ARIA invented for a test to query.
   */
  function slotAt(label: string): HTMLElement {
    const control = screen.getByRole('button', { name: label });
    const slot = control.closest('[data-roving-row]');

    expect(slot).toBeInstanceOf(HTMLElement);
    return slot as HTMLElement;
  }

  it('writes the hour the slot stands for, as a moment in the reader own zone', () => {
    const { setProperties } = renderWeek([LOOSE]);

    const dataTransfer = { effectAllowed: '', setData: vi.fn(), getData: vi.fn() };
    fireEvent.dragStart(screen.getByRole('button', { name: 'Loose end' }), { dataTransfer });
    fireEvent.drop(slotAt('Add an item at 09:00 on Thursday 12 March 2026'), { dataTransfer });

    expect(setProperties).toHaveBeenCalledWith('item-loose', {
      starts: '2026-03-12T09:00:00-10:00[Pacific/Honolulu]',
    });
  });

  it('leaves the unscheduled list alone when nothing is being dragged', () => {
    const { setProperties } = renderWeek([LOOSE]);

    fireEvent.drop(slotAt('Add an item at 09:00 on Thursday 12 March 2026'), {
      dataTransfer: { effectAllowed: '', setData: vi.fn(), getData: vi.fn() },
    });

    expect(setProperties).not.toHaveBeenCalled();
  });

  it('counts an item that has a time as scheduled, not as unscheduled', () => {
    renderWeek([
      itemOf('item-standup', 'Standup', { starts: '2026-03-12T09:00:00-10:00[Pacific/Honolulu]' }),
    ]);

    // The heading counts what is left. A timestamp read only as a plain date would fail to parse
    // and the item would be listed here as well as drawn on the grid - in two places at once,
    // which is the state a drop used to leave it in.
    expect(screen.getByRole('heading', { name: 'Unscheduled (0)' })).toBeVisible();
  });

  it('offers the keyboard a time of day, not only a date, when the calendar places by the hour', async () => {
    renderWeek([LOOSE]);

    await user().click(screen.getByRole('button', { name: 'Reschedule Loose end' }));

    expect(screen.getByLabelText('New date and time for Loose end')).toHaveAttribute(
      'type',
      'datetime-local',
    );
  });
});
