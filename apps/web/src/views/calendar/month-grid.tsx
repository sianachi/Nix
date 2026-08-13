import { Blueprint, Text, cn, focusRing } from '@nix/ui';
import type { ReactNode } from 'react';

import {
  daysInMonth,
  dayText,
  monthEntry,
  monthLabel,
  weekdayIndex,
  WEEKDAY_ABBREVIATIONS,
  WEEKDAY_NAMES,
  type CalendarMonth,
} from '../core/calendar-dates';

/**
 * A month, as a grid of weeks, with the cells left to the caller.
 *
 * **The scaffolding is shared; what goes in a day is not.** Two views draw a month now - a
 * container's calendar, which can create, drag and reschedule, and the workspace's collated
 * calendar, which reads across containers and cannot do any of those, because the write would have
 * to guess which container's property it meant. Sharing the whole cell would mean either giving the
 * collated view controls that do nothing, or bolting optional-ness onto the container view's cell
 * and putting its whole test suite in the blast radius. Sharing the table instead hands each caller
 * the part that is genuinely the same: the weekday header, the blanks either end, the accessible
 * name of every day, and the scroll region below.
 *
 * Nothing here reads a clock or a zone. The month is given, and `todayText` is passed in, so the
 * grid is a pure function of its arguments and the two callers cannot disagree about what day it is.
 */

/** One day of the grid: the number to draw, and the date it stands for. */
export interface DayCellSpec {
  readonly day: number;
  readonly date: string;
}

/**
 * The grid, as weeks of days with nulls for the slots either end that belong to another month.
 *
 * Built from the month's own arithmetic - length from the leap rule, first weekday from Sakamoto's
 * - so every cell carries the date text it stands for and no cell exists that this view cannot
 * name. Nothing here reads a clock or a zone.
 */
export function buildWeeks(month: CalendarMonth): readonly (readonly (DayCellSpec | null)[])[] {
  const cells: (DayCellSpec | null)[] = [];
  const lead = weekdayIndex(month.year, month.month, 1);

  for (let index = 0; index < lead; index += 1) {
    cells.push(null);
  }

  const length = daysInMonth(month);
  for (let day = 1; day <= length; day += 1) {
    cells.push({ day, date: dayText({ ...month, day: day }) });
  }

  while (cells.length % 7 !== 0) {
    cells.push(null);
  }

  const weeks: (DayCellSpec | null)[][] = [];
  for (let index = 0; index < cells.length; index += 7) {
    weeks.push(cells.slice(index, index + 7));
  }

  return weeks;
}

/** The width floor of a single day column. */
export const MONTH_DAY_COLUMN = 'w-[6.5rem]';

/**
 * The width floor of the whole grid: seven columns and their borders.
 *
 * Below this the grid scrolls rather than compressing, because seven columns squeezed into a phone
 * are seven columns of nothing legible.
 */
export const MONTH_GRID_MIN_WIDTH = 'min-w-[45.5rem]';

export interface MonthGridProps {
  /** The month to draw. */
  readonly month: CalendarMonth;

  /** Today, as `yyyy-MM-dd`, so the grid can mark it without reading a clock of its own. */
  readonly todayText: string;

  /**
   * Prefixes the keys of the rows and the blank cells.
   *
   * Two panes can show the same month at once, and React keys only have to be unique among
   * siblings - but a caller that renders two grids in one list would collide without this.
   */
  readonly prefix: string;

  /** Extra classes for the scroll region, for a caller that has to bleed a gutter into it. */
  readonly regionClassName?: string;

  /**
   * Draws one day.
   *
   * Given the cell, the accessible name the grid worked out for it, and whether it is today - so
   * every caller's cells are named the same way and a reader moving between the two views hears
   * the same sentence.
   */
  readonly renderDay: (cell: DayCellSpec, name: string, isToday: boolean) => ReactNode;
}

export function MonthGrid(props: MonthGridProps): ReactNode {
  const { month, todayText, prefix, regionClassName, renderDay } = props;

  return (
    /*
      The scroller sits *outside* the frame, and the arithmetic is why. The table's floor is 728px
      (`MONTH_GRID_MIN_WIDTH`), and around it stand the frame's 2px of border and its 24px of `p-3`.
      With the scroller inside the frame, a container a little wider than the table's floor had a
      region narrower than it, so the last column slid under the frame's right border - clipped
      against a hairline rather than visibly scrollable. Because the frame now travels with the
      table, the last column ends at the frame's own edge instead of under it.

      `role="region"` plus a tab stop, matching timeline-view.tsx's and calendar-hours.tsx's own
      scrollable tracks: without one, this axis is reachable by keyboard only by tabbing through
      every focusable control inside it. `<Blueprint>` cannot carry any of this itself - it forwards
      only `children`, `as` and `className` - so the scroll moves to this plain wrapper. `min-w-max`
      on the frame is what makes its box span the true scroll-content width; jsdom cannot verify any
      of the layout above, so the classes here are asserted as a contract in calendar-view.test.tsx.
    */
    <div
      role="region"
      aria-label={monthLabel(month)}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Justification: a scrollable region needs a tab stop or its content cannot be scrolled without a pointer.
      tabIndex={0}
      className={cn(regionClassName, 'overflow-x-auto', focusRing)}
    >
      <Blueprint className="min-w-max overflow-hidden p-3">
        <table className={cn('w-full table-fixed border-collapse', MONTH_GRID_MIN_WIDTH)}>
          <Text as="caption" variant="caption" className="sr-only">
            {`${monthLabel(month)}, items placed on the day their date names`}
          </Text>

          <thead>
            <tr>
              {WEEKDAY_NAMES.map((name, index) => (
                <th
                  key={name}
                  scope="col"
                  aria-label={name}
                  className={cn('border border-divider p-1 text-left', MONTH_DAY_COLUMN)}
                >
                  <Text variant="kicker" as="span" tone="muted">
                    {monthEntry(WEEKDAY_ABBREVIATIONS, index)}
                  </Text>
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {buildWeeks(month).map((week, weekIndex) => (
              <tr key={`${prefix}week-${String(weekIndex)}`}>
                {week.map((cell, dayIndex) =>
                  cell === null ? (
                    <td
                      key={`${prefix}blank-${String(weekIndex)}-${String(dayIndex)}`}
                      className="h-24 border border-divider bg-surface align-top"
                    />
                  ) : (
                    // The cell's accessible name carries the whole date, so somebody moving through
                    // the grid with a screen reader always knows which day they are on rather than
                    // hearing a bare "17".
                    renderDay(
                      cell,
                      `${monthEntry(WEEKDAY_NAMES, dayIndex)} ${String(cell.day)} ${monthLabel(month)}`,
                      cell.date === todayText,
                    )
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </Blueprint>
    </div>
  );
}
