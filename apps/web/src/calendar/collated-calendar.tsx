import type { CalendarEntry } from '@nix/api-client';
import { Blueprint, Button, Segmented, Text, focusRing } from '@nix/ui';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';

import { HourGrid } from '../views/calendar/calendar-hours';
import { MonthGrid } from '../views/calendar/month-grid';
import {
  addDays,
  dayLabel,
  dayText,
  monthLabel,
  shiftMonth,
  weekLabel,
  weekOf,
  type CalendarDay,
} from '../views/core/calendar-dates';
import { readerZone } from '../views/core/timestamps';
import { bucketByDay, containersById, COLLATED_DATE_KEY, toGridItems } from './collated-entries';
import type { CalendarGrain } from './calendar-window';

/**
 * Every calendar in the workspace, drawn as one.
 *
 * **The same grids the container calendar uses.** A month is `MonthGrid`, a week and a day are
 * `HourGrid`, so a reader who learns one calendar has learnt both and a change to either lands in
 * both places at once. What differs is what a day cell says: an entry here came from somewhere, and
 * saying which container is the whole point of collating.
 *
 * **Read-only, deliberately.** The container calendar can create and reschedule because it knows
 * which property it places by. This one does not: entries arrive placed by whatever their own
 * container names, so "create here" has no answer and a control that appeared and did nothing would
 * be worse than none. The grids take their write affordances as optional for exactly this caller.
 */

export interface CollatedCalendarProps {
  /**
   * The entries to draw.
   *
   * The entries rather than the whole response, because the page filters them before they get here
   * and a view that took the response would have to be told twice which of its entries were live.
   */
  readonly entries: readonly CalendarEntry[];

  /** Which grain to draw. Owned by the page, because the URL carries it. */
  readonly grain: CalendarGrain;
  readonly onGrain: (grain: CalendarGrain) => void;

  /** Where in time the reader is. Owned by the page so a refetch and the drawing agree. */
  readonly anchor: CalendarDay;
  readonly onAnchor: (anchor: CalendarDay) => void;

  /** Today, so nothing below reads a clock of its own. */
  readonly today: CalendarDay;

  /** Opens an item. Wired to the same `useOpenItem` the tree and the palette use. */
  readonly onOpen: (itemId: string) => void;
}

const GRAINS = [
  { value: 'month', label: 'Month' },
  { value: 'week', label: 'Week' },
  { value: 'day', label: 'Day' },
] as const satisfies readonly { value: CalendarGrain; label: string }[];

export function CollatedCalendar(props: CollatedCalendarProps): ReactNode {
  const { entries, grain, onGrain, anchor, onAnchor, today, onOpen } = props;

  // Keyed on the payload, so stepping the grain does not rebucket entries that have not changed.
  const byDay = useMemo(() => bucketByDay(entries), [entries]);
  const items = useMemo(() => toGridItems(entries), [entries]);
  const containers = useMemo(() => containersById(entries), [entries]);

  // One clock reading for the whole grid rather than one per cell: the answer cannot change halfway
  // through a render, and forty-two of them would be forty-two allocations for one fact.
  const todayText = dayText(today);
  const zone = readerZone();

  const step = (delta: number): void => {
    if (grain === 'month') {
      const moved = shiftMonth({ year: anchor.year, month: anchor.month }, delta);
      // Clamped, so stepping from the 31st into a shorter month does not roll into the next one.
      onAnchor({ ...moved, day: Math.min(anchor.day, 28) });
      return;
    }

    onAnchor(addDays(anchor, delta * (grain === 'week' ? 7 : 1)));
  };

  const label =
    grain === 'month'
      ? monthLabel({ year: anchor.year, month: anchor.month })
      : grain === 'week'
        ? weekLabel(anchor)
        : dayLabel(anchor);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="Calendar grain"
          options={GRAINS}
          value={grain}
          onChange={(next) => {
            onGrain(next);
          }}
        />

        <Button
          variant="icon"
          aria-label={`Previous ${grain}`}
          onClick={() => {
            step(-1);
          }}
        >
          <ChevronLeft aria-hidden="true" className="size-4" />
        </Button>

        <Button
          variant="icon"
          aria-label={`Next ${grain}`}
          onClick={() => {
            step(1);
          }}
        >
          <ChevronRight aria-hidden="true" className="size-4" />
        </Button>

        <Button
          variant="secondary"
          onClick={() => {
            onAnchor(today);
          }}
        >
          Today
        </Button>

        {/* Live, because the two step buttons change it and a reader who cannot see the grid
            redraw has no other way to know the press did anything. */}
        <Text as="span" variant="note" tone="muted" aria-live="polite">
          {label}
        </Text>
      </div>

      {grain === 'month' ? (
        <MonthGrid
          month={{ year: anchor.year, month: anchor.month }}
          todayText={todayText}
          prefix="collated-"
          renderDay={(cell, name, isToday) => (
            <td
              key={cell.date}
              aria-label={name}
              aria-current={isToday ? 'date' : undefined}
              className="h-24 border border-divider align-top"
            >
              <div className="flex h-full flex-col gap-0.5 p-1">
                <Text variant="caption" as="span" tone={isToday ? 'accent' : 'muted'}>
                  {String(cell.day)}
                </Text>

                {(byDay.get(cell.date) ?? []).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      onOpen(item.id);
                    }}
                    // The container's name is in the accessible name rather than on screen: a day
                    // cell is two centimetres wide, and a reader who needs to know where something
                    // came from needs it said rather than truncated.
                    aria-label={`${item.title}, in ${containers.get(item.id) ?? 'Untitled'}`}
                    className={`${focusRing} truncate rounded-sm bg-accent/18 px-1.5 py-0.5 text-left text-xs hover:bg-accent/25`}
                  >
                    {item.title}
                  </button>
                ))}
              </div>
            </td>
          )}
        />
      ) : (
        <Blueprint className="flex min-h-[520px] flex-col overflow-hidden p-0">
          <HourGrid
            days={grain === 'week' ? weekOf(anchor) : [anchor]}
            items={items}
            // Every entry was rewritten onto one key, because the grid takes one and these entries
            // came placed by whatever their own container names. See collated-entries.ts.
            dateProperty={COLLATED_DATE_KEY}
            zone={zone}
            today={todayText}
            onOpen={onOpen}
            // No create and no move: this view cannot know which container a new item would belong
            // to, and a write would have to guess which property it meant.
            dragged={null}
          />
        </Blueprint>
      )}
    </div>
  );
}
