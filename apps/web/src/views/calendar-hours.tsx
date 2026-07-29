import { Text } from '@nix/ui';
import type { ReactNode } from 'react';

import { dayLabel, dayText, type CalendarDay } from './calendar-dates';
import { readPropertyText, type Item } from './container-model';
import { CreateItemControl } from './create-item-control';
import { formatTime, minutesFor, readTimestampValue, writeTimestampValue } from './timestamps';

/**
 * A day or a week, drawn against the hours.
 *
 * **The grid is the reader's clock, always.** A timestamp keeps the zone it was written in, so an
 * item scheduled for 09:00 in London is not at 09:00 for somebody in Honolulu - it is at 23:00 the
 * evening before. Placing it without converting would put it in the right-looking slot for whoever
 * wrote it and the wrong one for everybody else, and it would look correct from the author's desk.
 *
 * An item whose zone differs from the reader's says so on the card. One whose zone matches says
 * nothing extra: repeating "Europe/London" beside every entry for somebody in London trains people
 * to stop reading it, and then it is not there when it matters.
 *
 * **All-day items are not on the grid.** A `date` property means "the 3rd" and has no hour to be
 * placed at; converting one into a moment to find a row is precisely the bug the date type exists
 * to avoid. They sit in a band above the hours, where a calendar has always put them.
 */

/** The rows. A full day, so a 23:00 item is reachable by scrolling rather than absent. */
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/**
 * The height of one hour, in pixels, and **the one place in the app that still sets `style`**.
 *
 * The grid is a coordinate space rather than a rhythm, which is what makes it the exception to the
 * ban in `app.css`. An item at 09:30 sits at `9.5 * ROW_HEIGHT` down the column - a number that
 * exists only once its timestamp has been read and converted into the reader's zone, so it is
 * computed at render. Expressing that as a class would need one utility per reachable offset, 1440
 * of them at minute resolution, and Tailwind's extractor cannot see a class name assembled from a
 * variable anyway - so the sheet would ship none of them. Rounding to a coarser set would place
 * items at times they are not at, which is the one thing a calendar must not do.
 *
 * It is 44px because a row is a click target and that is `--control-lg`, but it is used in
 * arithmetic rather than applied as a length, so it is written as the scalar the arithmetic needs.
 *
 * The row heights below could be classes; they are not, because they have to agree with the offsets
 * exactly. The same number said twice, once in a class and once in arithmetic, is how a grid drifts
 * an hour at a time.
 */
const ROW_HEIGHT = 44;

export interface HourGridProps {
  /** The days across the top. One for a day view, seven for a week. */
  readonly days: readonly CalendarDay[];

  /** Everything the container holds that this grid might place. */
  readonly items: readonly Item[];

  /** The property that places an item. */
  readonly dateProperty: string;

  /** The clock the grid is drawn in. */
  readonly zone: string;

  /** Today, as `yyyy-MM-dd` in the reader's zone, for marking the column. */
  readonly today: string;

  readonly onOpen: (itemId: string) => void;
  readonly onCreate: (
    title: string,
    properties?: Record<string, unknown>,
  ) => Promise<string | null>;
}

interface Placed {
  readonly item: Item;

  /** Minutes since midnight, in the reader's zone. Where on the column it sits. */
  readonly minutes: number;

  /** What the clock reads, in the reader's zone. */
  readonly at: string;

  /** The zone the item was written in, which the card names only when it differs. */
  readonly zone: string;
}

export function HourGrid(props: HourGridProps): ReactNode {
  const { days, items, dateProperty, zone, today, onOpen, onCreate } = props;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex">
        {/* The gutter's width has to match the one below it, or the columns and the hours drift
            apart as the grid scrolls. */}
        <span aria-hidden="true" className="w-12 shrink-0" />

        {days.map((day) => (
          <div key={dayText(day)} className="min-w-0 flex-1 px-1 py-1 text-center">
            <Text variant="caption" as="span" tone={dayText(day) === today ? 'accent' : 'muted'}>
              {dayLabel(day)}
            </Text>
          </div>
        ))}
      </div>

      <AllDayBand
        days={days}
        items={items}
        dateProperty={dateProperty}
        onOpen={onOpen}
        onCreate={onCreate}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex">
          <div className="w-12 shrink-0">
            {HOURS.map((hour) => (
              <div
                key={hour}
                style={{ height: `${String(ROW_HEIGHT)}px` }} // design-token-exempt: the same hour height as the labels beside it // design-token-exempt: an hour's height is the grid's unit; the labels must share it exactly or the columns drift apart down the day
                className="pr-1 text-right"
              >
                <Text variant="caption" as="span" tone="muted">
                  {`${String(hour).padStart(2, '0')}:00`}
                </Text>
              </div>
            ))}
          </div>

          {days.map((day) => (
            <DayColumn
              key={dayText(day)}
              day={day}
              placed={placeOn(day, items, dateProperty, zone)}
              dateProperty={dateProperty}
              zone={zone}
              onOpen={onOpen}
              onCreate={onCreate}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The items that fall on a day, in the reader's zone, with the minute each sits at.
 *
 * Converted before it is compared, which is the whole difference between this and the month grid.
 */
function placeOn(
  day: CalendarDay,
  items: readonly Item[],
  dateProperty: string,
  zone: string,
): readonly Placed[] {
  const wanted = dayText(day);

  return items
    .flatMap((item) => {
      const value = readTimestampValue(item.properties, dateProperty);
      if (value === null) {
        return [];
      }

      const local = value.at.setZone(zone);
      if (local.toFormat('yyyy-MM-dd') !== wanted) {
        return [];
      }

      return [
        {
          item,
          minutes: minutesFor(value, zone),
          at: formatTime(value, zone),
          zone: value.zone,
        },
      ];
    })
    .sort((left, right) => left.minutes - right.minutes);
}

function DayColumn(props: {
  readonly day: CalendarDay;
  readonly placed: readonly Placed[];
  readonly dateProperty: string;
  readonly zone: string;
  readonly onOpen: (itemId: string) => void;
  readonly onCreate: (
    title: string,
    properties?: Record<string, unknown>,
  ) => Promise<string | null>;
}): ReactNode {
  const { day, placed, dateProperty, zone, onOpen, onCreate } = props;

  return (
    <div
      aria-label={dayLabel(day)}
      className="relative min-w-0 flex-1 border-l border-divider"
      style={{ height: `${String(HOURS.length * ROW_HEIGHT)}px` }} // design-token-exempt: twenty-four hours of grid, computed from the row height rather than restated by hand
    >
      {HOURS.map((hour) => (
        <div
          key={hour}
          className="group/slot border-b border-divider"
          style={{ height: `${String(ROW_HEIGHT)}px` }} // design-token-exempt: the same hour height as the labels beside it
        >
          {/* One per hour, revealed on hover and on focus. Always in the tree, because a way to add
              something that exists only for a pointer is not a way everybody has. */}
          <CreateItemControl
            compact
            label={`Add an item at ${String(hour).padStart(2, '0')}:00 on ${dayLabel(day)}`}
            properties={{ [dateProperty]: writeSlot(day, hour, zone) }}
            onCreate={onCreate}
            className="invisible focus-within:visible focus-visible:visible group-hover/slot:visible"
          />
        </div>
      ))}

      {placed.map((entry) => (
        <button
          key={entry.item.id}
          type="button"
          onClick={() => {
            onOpen(entry.item.id);
          }}
          style={{ top: `${String((entry.minutes / 60) * ROW_HEIGHT)}px` }} // design-token-exempt: where an item sits is its own time - 09:30 is half a row down - a position read off the data, computed at runtime, so not a token
          className="absolute inset-x-1 flex flex-col items-start gap-0.5 rounded-sm bg-accent/18 px-1.5 py-1 text-left text-xs hover:bg-accent/25 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        >
          <span className="truncate font-medium">{readPropertyText(entry.item, 'title')}</span>
          <span className="text-muted">{timeLabel(entry, zone)}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * What an entry says about when it is.
 *
 * The zone is named only when it is not the reader's. Saying it every time would make the one time
 * it matters look like all the rest.
 */
function timeLabel(entry: Placed, zone: string): string {
  return entry.zone === zone ? entry.at : `${entry.at} · ${entry.zone}`;
}

/**
 * The stored value a slot stands for: that hour, on that day, in the reader's own zone.
 *
 * Written through the same function every other timestamp goes through, so the offset is derived
 * from the zone rather than assembled by hand - which is the one way it could end up disagreeing
 * with the zone beside it, and the server refuses exactly that.
 */
function writeSlot(day: CalendarDay, hour: number, zone: string): string | null {
  return writeTimestampValue(`${dayText(day)}T${String(hour).padStart(2, '0')}:00`, zone);
}

/**
 * The band above the hours, for items that have a date rather than a moment.
 *
 * They are not placed by time because they do not have one. Putting them at midnight would be an
 * invented answer that reads as a real one.
 */
function AllDayBand(props: {
  readonly days: readonly CalendarDay[];
  readonly items: readonly Item[];
  readonly dateProperty: string;
  readonly onOpen: (itemId: string) => void;
  readonly onCreate: (
    title: string,
    properties?: Record<string, unknown>,
  ) => Promise<string | null>;
}): ReactNode {
  const { days, items, dateProperty, onOpen, onCreate } = props;

  return (
    <div className="flex border-y border-divider">
      <span aria-hidden="true" className="w-12 shrink-0 pr-1 text-right">
        <Text variant="caption" as="span" tone="muted">
          All day
        </Text>
      </span>

      {days.map((day) => {
        const wanted = dayText(day);
        const allDay = items.filter((item) => item.properties[dateProperty] === wanted);

        return (
          <div
            key={wanted}
            aria-label={`All day on ${dayLabel(day)}`}
            className="group/allday min-w-0 flex-1 border-l border-divider p-1"
          >
            {allDay.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  onOpen(item.id);
                }}
                className="block w-full truncate rounded-sm bg-accent/18 px-1.5 py-0.5 text-left text-xs hover:bg-accent/25 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
              >
                {readPropertyText(item, 'title')}
              </button>
            ))}

            <CreateItemControl
              compact
              label={`Add an all-day item on ${dayLabel(day)}`}
              properties={{ [dateProperty]: wanted }}
              onCreate={onCreate}
              className="invisible focus-within:visible focus-visible:visible group-hover/allday:visible"
            />
          </div>
        );
      })}
    </div>
  );
}
