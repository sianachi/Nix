import { Text, cn, focusRing } from '@nix/ui';
import { useState, type DragEvent, type ReactNode } from 'react';

import { dayLabel, dayText, weekLabel, type CalendarDay } from '../core/calendar-dates';
import { readPropertyText, type Item } from '../core/container-model';
import { CreateItemControl } from '../core/create-item-control';
import {
  formatTime,
  minutesFor,
  readTimestampValue,
  writeTimestampValue,
} from '../core/timestamps';
import { useRovingGrid } from './use-roving-grid';

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

/**
 * One day column's floor width, shared by the header cell, the all-day band's cell and the hour
 * grid's own column - the same "the gutter's width has to match the one below it" requirement the
 * hour gutter already had, extended to every column rather than just the leftmost one.
 *
 * `min-w-0 flex-1` used to let seven columns divide up whatever width the viewport offered with no
 * floor, which on a phone is around 47px each: too narrow for the event card below to show a title
 * next to its time, and the column kept shrinking instead of the grid ever scrolling.
 *
 * 7rem (112px) is sized off what the card actually draws, not guessed: the event button sits
 * `inset-x-1` inside the column (4px a side) and pads itself `px-1.5` (6px a side), which leaves
 * about 92px of text at `text-xs` - comfortably one truncated title on its own line and a short time
 * like "09:00" on the one below, the two lines the card usually renders (a cross-zone entry's time
 * span carries its own `truncate` too, for the rarer third line a zone name can add). Below that a
 * title stops being a title and starts being an ellipsis before the second word. `sm:min-w-[9rem]`
 * widens it a touch once there is room, the way timeline-view.tsx's `LABEL_COLUMN` widens its own
 * floor at the same breakpoint.
 *
 * `[contain:inline-size]` stops a different failure than the floor above: without it, a browser
 * computing this row's max-content width (needed once the row has to overflow rather than shrink)
 * looks *through* a `flex-1` column at its children's own natural width - so one long all-day title
 * anywhere in the week inflates that column's contribution to hundreds of pixels, and flexbox's
 * max-content algorithm then multiplies that single widest column's width across every other
 * `flex-1` sibling, blowing the whole row out past 2000px. `contain: inline-size` tells the browser
 * this element's own intrinsic size is whatever its explicit `min-width`/`flex-basis` says, full
 * stop - it does not go looking at what is drawn inside. Verified in both week (7 columns) and day
 * (1 column) mode: a long all-day title no longer moves the row's width at all.
 */
const DAY_COLUMN = 'min-w-[7rem] sm:min-w-[9rem] flex-1 [contain:inline-size]';

/**
 * The hour gutter's own footprint, in whichever of the three rows it appears: the header's blank
 * spacer, the all-day band's "All day" label, and the hour column's row of clock times.
 *
 * `sticky left-0`, matching timeline-view.tsx's `LABEL_COLUMN` - once the grid scrolls horizontally
 * to reach a later day, a reader still needs to see which hour a row is without scrolling back.
 * `bg-surface` is load-bearing rather than decorative: without it, a day column's tinted event card
 * would show straight through the gutter as it slides underneath a sticky element with no fill of
 * its own. `border-r` is its own edge rather than a coincidence: without one, the gutter's right
 * boundary only ever looked bordered because a day column's own `border-l` happened to line up
 * behind it at a zero scroll offset - scroll even a pixel and the gutter has no edge of its own at
 * all.
 */
const HOUR_GUTTER = 'sticky left-0 z-10 w-12 shrink-0 border-r border-divider bg-surface';

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

  /**
   * The item a pointer is currently dragging, or null.
   *
   * Read from the calendar rather than from `dataTransfer`, for the reason `board-view.tsx` gives:
   * the payload a drag starts with is not readable during `dragover`, so a slot cannot decide
   * whether to light up from the event alone.
   */
  readonly dragged: string | null;

  /** Where a dropped item is written to. The value is a stored timestamp, or null to unschedule. */
  readonly onMove: (itemId: string, value: string | null) => void;
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
  const { days, items, dateProperty, zone, today, onOpen, onCreate, dragged, onMove } = props;

  // One tab stop for all 168 hour-slot create controls, with the arrow keys moving which slot it
  // is: Up and Down walk the hours, Left and Right walk the days, Home and End jump to the first
  // and last day at the same hour, and Ctrl with either to midnight on the first day and 23:00 on
  // the last. See the hook's own doc for the APG mapping and for why the tabindex is managed from
  // here rather than by each control.
  const { containerRef, onKeyDown, onFocusCapture } = useRovingGrid(HOURS.length, days.length);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/*
       * One scroll container for the whole grid, on both axes, rather than the header and the
       * all-day band scrolling through an outer frame while the hour body scrolls through a nested
       * one of its own. CSS ties `overflow-x` and `overflow-y` together the moment either leaves
       * `visible`: an element given `overflow-y-auto` and no opinion on `overflow-x` does not let
       * its horizontal content spill out to a wider ancestor's scrollbar - it silently computes its
       * own `overflow-x` to `auto` and clips right there instead. Two scroll boundaries for content
       * that has to move together as one grid would mean two scrollbars that can drift out of sync,
       * with the day headers no longer lined up over the hours they name. So the header, the
       * all-day band and the hour rows all live inside this single scroller, and staying in view
       * while it scrolls is `sticky`'s job below rather than a second scroller's.
       *
       * `role="region"` plus a tab stop, matching timeline-view.tsx's own scrollable track: without
       * one, this content is reachable only by dragging a scrollbar, which a keyboard user does not
       * have.
       */}
      <div
        role="region"
        aria-label={regionLabel(days)}
        // The rule cannot see that this element scrolls, and only its author can. Without a tab
        // stop the grid is reachable by keyboard only by tabbing through the controls inside it, so
        // somebody who wants to read a later day has to activate something to get there.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Justification: a scrollable region needs a tab stop or its content cannot be scrolled without a pointer.
        tabIndex={0}
        className={cn('min-h-0 flex-1 overflow-auto', focusRing)}
      >
        {/* The one element whose own box actually spans the true scroll-content width. `min-w-max`
            asks it to be at least as wide as its content's max-content size - and that size is now
            trustworthy because every `DAY_COLUMN` inside carries `[contain:inline-size]`, so a long
            title cannot inflate it. The sticky header block and the hour body both have to sit
            inside this same width owner: a `sticky` element's containing block is its nearest
            scrolling ancestor, but its *edge* only reaches as far as this box actually extends, so
            without a shared wide ancestor the header's background and the gutter's sticky
            positioning would both stop at the scroller's own (narrower) viewport width instead of
            the real scrolled extent. */}
        <div className="min-w-max">
          {/* Pinned to the top of the scroller as the hour rows scroll past beneath it - the same
              frozen header a spreadsheet gives its column titles. Both rows sit inside one sticky
              block, rather than each being sticky on its own, so nothing has to know the header's
              rendered height to place the all-day band directly under it. */}
          <div className="sticky top-0 z-20 bg-surface">
            <div className="flex">
              <span aria-hidden="true" className={HOUR_GUTTER} />

              {days.map((day) => (
                <div key={dayText(day)} className={cn(DAY_COLUMN, 'px-1 py-1 text-center')}>
                  <Text
                    variant="caption"
                    as="span"
                    tone={dayText(day) === today ? 'accent' : 'muted'}
                  >
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
          </div>

          {/* The roving container: keydown and focus are watched from here because the slots
              inside come and go as their create fields open, while this element is the one stable
              ancestor they all share. It is not itself interactive - the handlers only steer
              which of the buttons inside is the tab stop - which is what the rule below cannot
              see from the outside. */}
          {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- Justification: the handlers implement a roving tabindex over the buttons inside; the element itself is never a target and gets no role, no tab stop and no name. */}
          <div
            ref={containerRef}
            onKeyDown={onKeyDown}
            onFocusCapture={onFocusCapture}
            className="flex"
          >
            <div className={HOUR_GUTTER}>
              {HOURS.map((hour) => (
                <div
                  key={hour}
                  style={{ height: `${String(ROW_HEIGHT)}px` }} // design-token-exempt: an hour's height is the grid's unit; the labels must share it exactly or the columns drift apart down the day
                  className="pr-1 text-right"
                >
                  <Text variant="caption" as="span" tone="muted">
                    {`${String(hour).padStart(2, '0')}:00`}
                  </Text>
                </div>
              ))}
            </div>

            {days.map((day, dayIndex) => (
              <DayColumn
                key={dayText(day)}
                day={day}
                dayIndex={dayIndex}
                placed={placeOn(day, items, dateProperty, zone)}
                dateProperty={dateProperty}
                zone={zone}
                onOpen={onOpen}
                onCreate={onCreate}
                dragged={dragged}
                onMove={onMove}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * How the scroll region names itself to a screen reader: the week it spans, or the single day, the
 * same distinction `weekLabel`/`dayLabel` already draw for the heading above this grid.
 *
 * Falls back to a bare "Calendar" rather than throwing on an empty `days` - callers only ever pass
 * one day or seven, but a prop typed as an array can still arrive empty, and a label is not worth a
 * crash.
 */
function regionLabel(days: readonly CalendarDay[]): string {
  const first = days[0];
  if (first === undefined) {
    return 'Calendar';
  }

  return days.length === 1 ? dayLabel(first) : weekLabel(first);
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

  /** The column's position in the roving grid: which day Left and Right arrive at. */
  readonly dayIndex: number;
  readonly placed: readonly Placed[];
  readonly dateProperty: string;
  readonly zone: string;
  readonly onOpen: (itemId: string) => void;
  readonly onCreate: (
    title: string,
    properties?: Record<string, unknown>,
  ) => Promise<string | null>;
  readonly dragged: string | null;
  readonly onMove: (itemId: string, value: string | null) => void;
}): ReactNode {
  const { day, dayIndex, placed, dateProperty, zone, onOpen, onCreate, dragged, onMove } = props;

  return (
    <div
      aria-label={dayLabel(day)}
      className={cn(DAY_COLUMN, 'relative border-l border-divider')}
      style={{ height: `${String(HOURS.length * ROW_HEIGHT)}px` }} // design-token-exempt: twenty-four hours of grid, computed from the row height rather than restated by hand
    >
      {HOURS.map((hour) => (
        <HourSlot
          key={hour}
          day={day}
          dayIndex={dayIndex}
          hour={hour}
          dateProperty={dateProperty}
          zone={zone}
          onCreate={onCreate}
          dragged={dragged}
          onMove={onMove}
        />
      ))}

      {placed.map((entry) => (
        <button
          key={entry.item.id}
          type="button"
          onClick={() => {
            onOpen(entry.item.id);
          }}
          style={{ top: `${String((entry.minutes / 60) * ROW_HEIGHT)}px` }} // design-token-exempt: where an item sits is its own time - 09:30 is half a row down - a position read off the data, computed at runtime, so not a token
          className="absolute inset-x-1 flex flex-col gap-0.5 rounded-sm bg-accent/18 px-1.5 py-1 text-left text-xs hover:bg-accent/25 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        >
          <span className="truncate font-medium">{readPropertyText(entry.item, 'title')}</span>
          <span className="truncate text-muted">{timeLabel(entry, zone)}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * One hour of one day: the thing an item is created in, and the thing an item is dropped into.
 *
 * Its own component because each of the 168 slots owns a `hovered` flag, and a flag held in the
 * column would re-render all twenty-four rows of it on every `dragover` the pointer crosses.
 *
 * **The drop writes a time; the keyboard needs to be able to write one too.** That is why
 * `RescheduleDialog` takes a `datetime-local` for a timestamp property rather than a bare date -
 * the same argument ADR-0009 made against a drop zone that existed only for a pointer, applied to
 * the hour rather than to the day.
 */
function HourSlot(props: {
  readonly day: CalendarDay;
  readonly dayIndex: number;
  readonly hour: number;
  readonly dateProperty: string;
  readonly zone: string;
  readonly onCreate: (
    title: string,
    properties?: Record<string, unknown>,
  ) => Promise<string | null>;
  readonly dragged: string | null;
  readonly onMove: (itemId: string, value: string | null) => void;
}): ReactNode {
  const { day, dayIndex, hour, dateProperty, zone, onCreate, dragged, onMove } = props;
  const [over, setOver] = useState(false);

  const at = `${String(hour).padStart(2, '0')}:00`;

  return (
    <div
      // The roving-grid markers: which cell this slot is, for the hook that keeps exactly one
      // of the 168 create controls in the tab order. See use-roving-grid.ts.
      data-roving-row={hour}
      data-roving-column={dayIndex}
      onDragOver={(event: DragEvent<HTMLDivElement>) => {
        // Without this the browser refuses the drop outright, so it runs whether or not this
        // calendar started the drag - the highlight below is what is conditional.
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => {
        setOver(false);
      }}
      onDrop={(event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        setOver(false);
        if (dragged !== null) {
          // The hour is the whole point of dropping here rather than on a day: a drop writes the
          // moment the slot stands for, in the reader's zone, through the same function the slot's
          // create control writes.
          onMove(dragged, writeSlot(day, hour, zone));
        }
      }}
      className={cn(
        'group/slot border-b border-divider',
        over && dragged !== null ? 'outline-2 -outline-offset-2 outline-accent' : '',
      )}
      style={{ height: `${String(ROW_HEIGHT)}px` }} // design-token-exempt: the same hour height as the labels beside it
    >
      {/* One per hour, revealed on hover and on focus. Always in the tree, because a way to add
          something that exists only for a pointer is not a way everybody has.
          `opacity-0`/`pointer-events-none`, not `invisible`: `visibility: hidden` takes an
          element out of the tab order entirely, so `focus-visible:visible` could never fire -
          nothing could tab to the control in order to un-hide it. See the same pattern, with
          the same reasoning, on workspace-sidebar.tsx's row-hover controls. */}
      <CreateItemControl
        compact
        label={`Add an item at ${at} on ${dayLabel(day)}`}
        properties={{ [dateProperty]: writeSlot(day, hour, zone) }}
        onCreate={onCreate}
        className="opacity-0 pointer-events-none focus-within:pointer-events-auto focus-within:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/slot:pointer-events-auto group-hover/slot:opacity-100"
      />
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
      <span aria-hidden="true" className={cn(HOUR_GUTTER, 'pr-1 text-right')}>
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
            // `flex flex-col gap-2` rather than a plain block: the chips below extend their hit
            // area 3.4px past each edge, so two stacked chips with no gap between them would
            // overlap by 6.8px and the later sibling would paint over it - the bottom of every
            // chip opening the item below it. WCAG 2.5.8's spacing exception is about area that
            // belongs to nobody else, so borrowing it from the neighbour does not satisfy the
            // floor. gap-2 is 6.8px, exactly the two 3.4px extensions, so they meet and never
            // overlap. The create control below the chips extends 1.7px (`-inset-y-0.5`), well
            // inside the same gap.
            className={cn(
              DAY_COLUMN,
              // The "bordered group -> p-3" role names a *panel* - a bordered box standing on the
              // page, like the board's column or the timeline's off-axis list. This is a cell in a
              // band of seven, and its `border-l` is the rule between two columns rather than a
              // frame around one. p-3 here would be 24px of padding inside a 112px column, most of
              // the width of the chips it holds; this row of cells has always been p-1 and its
              // neighbour, the hour gutter, pads to match.
              'group/allday flex flex-col gap-2 border-l border-divider p-1', // spacing-role-exempt: a band cell, not a panel - see above
            )}
          >
            {allDay.map((item) => (
              /* `relative before:*`: the drawn chip is about 19px tall (`text-xs` at its 1.4 line
                 height plus `py-0.5`), under WCAG 2.5.8's 24px floor, and making it taller would
                 push the band's rows apart. The pseudo-element widens what a pointer has to hit
                 without widening what the eye sees - the same technique, with the same reasoning,
                 as @nix/ui's PaneDivider grab band. `-inset-y-1` is one spacing step (3.4px) past
                 each edge, which clears the floor with room for the density to tighten. The
                 column's `gap-2` is what gives those extensions somewhere to go; see it above. */
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  onOpen(item.id);
                }}
                className="relative block w-full truncate rounded-sm bg-accent/18 px-1.5 py-0.5 text-left text-xs before:absolute before:inset-x-0 before:-inset-y-1 hover:bg-accent/25 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
              >
                {readPropertyText(item, 'title')}
              </button>
            ))}

            {/* `opacity-0`/`pointer-events-none`, not `invisible` - see the hour cell's own
                control above for why `visibility: hidden` breaks the keyboard path entirely. */}
            <CreateItemControl
              compact
              label={`Add an all-day item on ${dayLabel(day)}`}
              properties={{ [dateProperty]: wanted }}
              onCreate={onCreate}
              className="opacity-0 pointer-events-none focus-within:pointer-events-auto focus-within:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/allday:pointer-events-auto group-hover/allday:opacity-100"
            />
          </div>
        );
      })}
    </div>
  );
}
