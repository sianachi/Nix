import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CalendarDay } from '../../views/calendar-dates';
import { HourGrid } from '../../views/calendar-hours';
import { CalendarView } from '../../views/calendar-view';
import { aContainer, views } from '../../views/container-fixture';
import type { EffectiveSchema, Item, View } from '../../views/container-model';
import { renderAt } from '../render-with-router';

/**
 * The week grid's layout at a narrow width: a floor on every day column, one scroller for the
 * whole grid, and a gutter that stays put on both axes - plus a check that day mode, which renders
 * through the same `HourGrid`, shares the same scroll model rather than having quietly diverged.
 *
 * **What this cannot prove.** jsdom performs no layout - every element is zero by zero, nothing
 * overflows anything, and there is no scrollbar to measure - so nothing here can show that seven
 * 7rem columns actually overflow a 375px viewport, or that the sticky gutter visually stays where
 * a screenshot would show it staying. That is a claim about rendered layout, which belongs in a
 * browser-based pass (Storybook + axe, U10), not a jsdom one; see `sidebar-drawer.test.tsx`'s own
 * note on the same limit. What is checkable, and what this checks, is the class contract: the
 * width floor, the single scroll container, and the sticky positioning are each spelled out as
 * Tailwind classes, and those classes are either present on the right element or they are not.
 */

const SCHEMA: EffectiveSchema = {
  properties: [{ key: 'starts', label: 'Starts', type: 'timestamp', options: [], required: false }],
  declared: [],
  inherit: true,
};

function weekView(): View {
  return {
    id: 'schedule',
    name: 'Schedule',
    kind: 'calendar',
    columns: [],
    groupBy: null,
    groupOrder: [],
    dateProperty: 'starts',
    sortBy: null,
    sortDescending: false,
    mode: 'week',
    coverProperty: null,
    endDateProperty: null,
  };
}

function itemOf(id: string, title: string, properties: Record<string, unknown>): Item {
  return {
    id,
    workspaceId: 'a1000000-0000-4000-8000-000000000001',
    parentId: 'c1000000-0000-4000-8000-000000000001',
    type: 'note',
    title,
    hasChildren: false,
    seq: 1000,
    lifecycleState: 'active',
    properties: { title, ...properties },
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
  };
}

const STANDUP = itemOf('item-standup', 'Standup', {
  starts: '2026-03-16T09:00:00-10:00[Pacific/Honolulu]',
});

function renderWeek(): void {
  const view = weekView();
  renderAt(
    <CalendarView
      container={aContainer({ schema: SCHEMA, views: views([view]), children: [STANDUP] })}
      view={view}
      onOpen={vi.fn()}
    />,
    '/',
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  // A Tuesday in the middle of March 2026, from local parts - a parsed string would be a different
  // day here than on a machine in UTC.
  vi.setSystemTime(new Date(2026, 2, 17, 12, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a day column at any width the grid is shown at', () => {
  it('carries a width floor instead of shrinking to fit whatever room seven columns are given', () => {
    renderWeek();

    // The day column itself: the hour grid's cell for Monday the 16th, which places the standup.
    const column = screen.getByLabelText('Monday 16 March 2026');
    expect(column).toHaveClass('min-w-[7rem]', 'sm:min-w-[9rem]');
  });

  it('gives the header cell the same floor as the day column beneath it', () => {
    renderWeek();

    // The header names each day by the same label the column below it carries, so the day names
    // are found by their own text rather than by role - there is no heading role on a plain cell.
    const header = screen.getByText('Monday 16 March 2026').closest('div');
    expect(header).toHaveClass('min-w-[7rem]', 'sm:min-w-[9rem]');
  });

  it('gives the all-day band the same floor too, so its cells line up with the hour grid below', () => {
    renderWeek();

    const band = screen.getByLabelText('All day on Monday 16 March 2026');
    expect(band).toHaveClass('min-w-[7rem]', 'sm:min-w-[9rem]');
  });

  it('contains its own intrinsic size instead of letting a long title inflate the row', () => {
    renderWeek();

    // `[contain:inline-size]` is what stops one long all-day title from being read as this
    // column's max-content width and then multiplied across every other `flex-1` sibling - see
    // the `DAY_COLUMN` docblock. Deleting the class leaves every other assertion in this file
    // green, so it is asserted here on its own.
    const column = screen.getByLabelText('Monday 16 March 2026');
    expect(column).toHaveClass('[contain:inline-size]');
  });
});

describe('the week grid at a width narrower than seven floors', () => {
  it('scrolls on both axes from one container shared by the header and every day column', () => {
    renderWeek();

    // Resolved from two different elements that ought to share the same scroller: a day column,
    // and a header cell above it. Matching `.overflow-auto` from a single element would still pass
    // if a second, nested `.overflow-y-auto` scroller were reintroduced beneath it - that only
    // proves *a* scroller exists somewhere above, not that the whole grid shares one. Resolving
    // from two places and asserting they land on the same node, then checking that node has no
    // other `overflow-*` element inside it, is what actually proves "one scroller for the whole
    // grid" rather than merely being consistent with it.
    const fromColumn = screen.getByLabelText('Monday 16 March 2026').closest('.overflow-auto');
    const fromHeader = screen.getByText('Monday 16 March 2026').closest('.overflow-auto');

    expect(fromColumn).toBeInstanceOf(HTMLElement);
    expect(fromColumn).toBe(fromHeader);

    const nestedScrollers = fromColumn?.querySelectorAll('[class*="overflow-"]') ?? [];
    expect(nestedScrollers).toHaveLength(0);
  });

  it('gives the scroller a child whose own box spans the true scroll-content width', () => {
    renderWeek();

    // `min-w-max` is what makes this wrapper's box actually reach the grid's full scrolled
    // extent, rather than stopping at the scroller's own narrower viewport width - which is what
    // the sticky header and gutter both need a containing block wide enough to stick across. See
    // the wrapper's own comment in calendar-hours.tsx for why that matters.
    const wrapper = screen.getByLabelText('Monday 16 March 2026').closest('.min-w-max');
    expect(wrapper).toBeInstanceOf(HTMLElement);
  });

  it('keeps the day header and the all-day band pinned to the top as the hour rows scroll past', () => {
    renderWeek();

    const header = screen.getByText('Monday 16 March 2026').closest('.sticky.top-0');
    const band = screen.getByLabelText('All day on Monday 16 March 2026').closest('.sticky.top-0');

    // The same element: one sticky block holding both, so nothing has to know the header's
    // rendered height to place the all-day band directly beneath it.
    expect(header).not.toBeNull();
    expect(header).toBe(band);
  });

  it('keeps the hour gutter pinned to the left edge in all three rows as the day columns scroll', () => {
    renderWeek();

    // The header's blank spacer above the gutter, the all-day band's own "All day" label, and the
    // hour column's row of clock times: three separate elements, one sticky-left contract.
    //
    // Like the rest of this file (see the note at the top), this checks the class contract only:
    // that each element is still asked to stick, not that it visibly holds its position once
    // scrolled - jsdom performs no layout, so nothing here can show the gutter's rendered position
    // actually staying put. Whether it now has a real containing block to stick *to* is fix 1's
    // job (the `min-w-max` wrapper and `contain: inline-size`), verified separately in a browser.
    const headerGutter = screen
      .getByText('Monday 16 March 2026')
      .closest('div')
      ?.parentElement?.querySelector(':scope > [aria-hidden="true"]');
    const allDayGutter = screen.getByText('All day').closest('span[aria-hidden]');
    const hourGutter = screen.getByText('00:00').closest('div')?.parentElement;

    for (const gutter of [headerGutter, allDayGutter, hourGutter]) {
      // An instance check, not `not.toBeNull()`: the lookups above chain optional properties, so a
      // broken step resolves to `undefined` rather than `null` and would slip past a null check
      // silently, leaving only the `toHaveClass` below to notice - which says "wrong classes" for
      // what is actually "found nothing at all".
      expect(gutter).toBeInstanceOf(HTMLElement);
      expect(gutter).toHaveClass('sticky', 'left-0', 'bg-surface');
    }
  });
});

describe('day mode, which shares this same grid and scroller', () => {
  function renderDay(): void {
    const day: CalendarDay = { year: 2026, month: 2, day: 16 };
    renderAt(
      <HourGrid
        days={[day]}
        items={[STANDUP]}
        dateProperty="starts"
        zone="Pacific/Honolulu"
        today="2026-03-16"
        onOpen={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(null)}
      />,
      '/',
    );
  }

  it('renders its one column inside the same overflow-auto scroller, carrying the same floor', () => {
    renderDay();

    // In day mode the scroll region and its single day column carry the same label text - a
    // region named "Monday 16 March 2026" holding a column named the same is exactly what a
    // one-day grid is - so the column is picked out as the labelled element that is not itself
    // the region landmark.
    const [column] = screen
      .getAllByLabelText('Monday 16 March 2026')
      .filter((element) => element.getAttribute('role') !== 'region');

    expect(column).toBeInstanceOf(HTMLElement);
    expect(column).toHaveClass('min-w-[7rem]', 'sm:min-w-[9rem]');
    expect(column?.closest('.overflow-auto')).toBeInstanceOf(HTMLElement);
  });
});
