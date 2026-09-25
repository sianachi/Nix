import { Button, Icon, Text, cn, focusRing } from '@nix/ui';
import { CalendarClock } from 'lucide-react';
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
import { RescheduleDialog } from './reschedule-dialog';
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
 *
 * Exported so a test that needs a pixel offset computes it from this number rather than restating
 * it by hand - a second copy of `44` in a test file is the same drift risk one step removed.
 */
export const ROW_HEIGHT = 44;

/**
 * `ROW_HEIGHT`'s own arithmetic, named for what it converts rather than repeated inline at every
 * call site - the offset, the full-day height and a span's own height are all "some number of
 * minutes, at this grid's scale".
 */
export function minutesToPx(minutes: number): number {
  return (minutes / 60) * ROW_HEIGHT;
}

/**
 * The shortest a timed span is ever drawn, regardless of its real duration.
 *
 * `minutesToPx` alone put a span under about thirty-eight minutes at less than `--control-sm`
 * (28px) tall, and `overflow: hidden` on that box - needed so a short span's two lines of text
 * cannot bleed into the row below it, see the span's own comment - clipped its Reschedule button
 * along with them, shrinking its hit area under the 24px floor WCAG 2.5.8 sets. Clamping the
 * height rather than lifting the clip keeps the box's top exactly where the item starts; only the
 * bottom ever moves, and only when the real duration would have drawn a box too short to hold its
 * own control.
 *
 * The number is `--control-sm` restated as a scalar for the same reason `ROW_HEIGHT` is: it is
 * used in a `Math.max` against a runtime pixel value, not applied as a Tailwind length.
 */
const MIN_SPAN_HEIGHT_PX = 28;

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

  /**
   * The property that closes a placed item's span, or null when the view has none configured.
   *
   * Threaded through to `placeOn`, which draws an item that has one as a bar reaching from its
   * start to its end rather than as a point, and to the reschedule dialog, which is where that
   * end gets written.
   */
  readonly endDateProperty?: string | null;

  /** The clock the grid is drawn in. */
  readonly zone: string;

  /** Today, as `yyyy-MM-dd` in the reader's zone, for marking the column. */
  readonly today: string;

  readonly onOpen: (itemId: string) => void;
  /**
   * Adds an item to the day or slot it is offered on.
   *
   * Optional, and absent means the grid offers no way to create. The collated calendar reads across
   * containers, so "create here" has no answer - there is no one container a new item would belong
   * to. A control that appeared and did nothing would be worse than no control.
   */
  readonly onCreate?:
    ((title: string, properties?: Record<string, unknown>) => Promise<string | null>) | undefined;

  /**
   * The item a pointer is currently dragging, or null.
   *
   * Read from the calendar rather than from `dataTransfer`, for the reason `board-view.tsx` gives:
   * the payload a drag starts with is not readable during `dragover`, so a slot cannot decide
   * whether to light up from the event alone.
   */
  readonly dragged: string | null;

  /**
   * Reschedules an item onto the slot it was dropped on, or onto the draft the reschedule dialog
   * was submitted with.
   *
   * Takes a bag of properties rather than a bare value, because the dialog may write two - the
   * start and, when this grid was given `endDateProperty`, the end - as one edit. A drop still
   * writes only `dateProperty`; the bag has one key either way.
   *
   * Optional, and absent means the grid accepts no drops. Paired with `dragged`, which is null for
   * the same caller - a grid that took a drop it could not write would silently discard it.
   */
  readonly onMove?: ((itemId: string, values: Record<string, string | null>) => void) | undefined;
}

/** Minutes in a full day, for clamping a span that runs past midnight. */
const MINUTES_PER_DAY = 24 * 60;

interface Placed {
  readonly item: Item;

  /** Minutes since midnight, in the reader's zone. Where on the column it sits. */
  readonly minutes: number;

  /** What the clock reads, in the reader's zone. */
  readonly at: string;

  /** The zone the item was written in, which the card names only when it differs. */
  readonly zone: string;

  /**
   * How long the entry runs for, in minutes, clamped to the rest of this day - or null for a
   * point.
   *
   * Null covers three cases that all draw the same way an item with no end always has: the view
   * has no `endDateProperty` configured, the item has no value for it, or the value is not after
   * the start (an end before its start is the reversed span timeline-view.tsx also refuses to
   * draw as a bar, rather than as one with a length that would run backwards). An end that lands
   * on a later day is clamped to midnight rather than drawn past it - this grid is one day tall,
   * and a bar continuing into tomorrow's column belongs to a multi-day rendering this grid does
   * not attempt.
   */
  readonly durationMinutes: number | null;
}

export function HourGrid(props: HourGridProps): ReactNode {
  const {
    days,
    items,
    dateProperty,
    endDateProperty = null,
    zone,
    today,
    onOpen,
    onCreate,
    dragged,
    onMove,
  } = props;

  // One tab stop for all 168 hour-slot create controls, with the arrow keys moving which slot it
  // is: Up and Down walk the hours, Left and Right walk the days, Home and End jump to the first
  // and last day at the same hour, and Ctrl with either to midnight on the first day and 23:00 on
  // the last. See the hook's own doc for the APG mapping and for why the tabindex is managed from
  // here rather than by each control.
  const { containerRef, onKeyDown, onFocusCapture } = useRovingGrid(HOURS.length, days.length);

  // Which placed item's reschedule dialog is open, or null. Held here rather than per column: a
  // week has seven `DayColumn`s and the dialog is one modal, not seven that would have to agree
  // which of them owns it.
  const [rescheduling, setRescheduling] = useState<string | null>(null);
  const reschedulingItem =
    rescheduling === null ? null : (items.find((item) => item.id === rescheduling) ?? null);

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
                placed={placeOn(day, items, dateProperty, endDateProperty, zone)}
                dateProperty={dateProperty}
                zone={zone}
                onOpen={onOpen}
                onCreate={onCreate}
                dragged={dragged}
                onMove={onMove}
                onReschedule={onMove === undefined ? undefined : setRescheduling}
              />
            ))}
          </div>
        </div>
      </div>

      {/* One dialog, at the root of the grid, for whichever placed item asked. Placed items used
          to answer only to `onOpen` - a click opened the item, and there was no way to move it
          except to drag it, which a keyboard and a touch screen alike cannot do. This reaches the
          same write `onMove` makes for a drop, from a tap or from the keyboard. */}
      {reschedulingItem === null || onMove === undefined ? null : (
        <RescheduleDialog
          key={reschedulingItem.id}
          item={reschedulingItem}
          dateProperty={dateProperty}
          endDateProperty={endDateProperty}
          // Every item this grid places has a moment on `dateProperty` - `placeOn` below reads one
          // to decide the row, so nothing reaches this dialog without one. The end field, when the
          // view has one, is assumed to be the same shape - see `RescheduleDialogProps.endDateProperty`.
          placesByTime
          zone={zone}
          onCancel={() => {
            setRescheduling(null);
          }}
          onMove={(values) => {
            onMove(reschedulingItem.id, values);
            setRescheduling(null);
          }}
        />
      )}
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
  endDateProperty: string | null,
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

      const minutes = minutesFor(value, zone);

      return [
        {
          item,
          minutes,
          at: formatTime(value, zone),
          zone: value.zone,
          durationMinutes: spanMinutes(item, endDateProperty, wanted, minutes, zone),
        },
      ];
    })
    .sort((left, right) => left.minutes - right.minutes);
}

/**
 * How long a placed item's span reaches into this day, or null for a point.
 *
 * See `Placed.durationMinutes` for the three cases that all collapse to null and the clamp that
 * keeps an overnight item's bar from running into a column that is not this one.
 */
function spanMinutes(
  item: Item,
  endDateProperty: string | null,
  startDay: string,
  startMinutes: number,
  zone: string,
): number | null {
  if (endDateProperty === null) {
    return null;
  }

  const end = readTimestampValue(item.properties, endDateProperty);
  if (end === null) {
    return null;
  }

  const endLocal = end.at.setZone(zone);
  const endDay = endLocal.toFormat('yyyy-MM-dd');

  if (endDay === startDay) {
    const duration = endLocal.hour * 60 + endLocal.minute - startMinutes;
    return duration > 0 ? duration : null;
  }

  // `yyyy-MM-dd` text sorts the same lexically as it does by calendar day - the same fact
  // reschedule-dialog.tsx's own end check leans on for a bare date. An end on an earlier day is
  // the reversed case above and draws as a point; an end on a later day runs off the bottom of
  // this one column, clamped to midnight.
  return endDay > startDay ? MINUTES_PER_DAY - startMinutes : null;
}

/**
 * Where each placed item sits sideways, so two items whose spans overlap in time sit side by side
 * rather than one painting over the other.
 *
 * A greedy sweep over intervals sorted by start: an item takes the lowest lane whose last
 * occupant has already ended, or opens a new one. Lanes are scoped to a cluster of
 * mutually-touching intervals rather than to the whole day, so a single busy hour does not
 * squeeze every other item on the day down to a sliver it does not need. A point (no
 * `durationMinutes`) counts as occupying one minute for this purpose only - long enough that two
 * items placed at the exact same minute are still treated as overlapping and laned apart, short
 * enough that it never overlaps a neighbour a whole hour away.
 */
function layout(placed: readonly Placed[]): readonly (Placed & { lane: number; lanes: number })[] {
  const intervals = placed
    .map((entry) => ({
      entry,
      start: entry.minutes,
      end: entry.minutes + Math.max(entry.durationMinutes ?? 1, 1),
    }))
    .sort((left, right) => left.start - right.start || left.end - right.end);

  const results: (Placed & { lane: number; lanes: number })[] = [];

  // The end minute each open lane's current occupant reaches, index by lane number.
  let laneEnds: number[] = [];
  let cluster: { readonly entry: Placed; readonly lane: number }[] = [];

  function closeCluster(): void {
    const lanes = laneEnds.length;
    for (const member of cluster) {
      results.push({ ...member.entry, lane: member.lane, lanes });
    }
    cluster = [];
    laneEnds = [];
  }

  for (const interval of intervals) {
    if (laneEnds.length > 0 && laneEnds.every((end) => end <= interval.start)) {
      closeCluster();
    }

    let lane = laneEnds.findIndex((end) => end <= interval.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(interval.end);
    } else {
      laneEnds[lane] = interval.end;
    }

    cluster.push({ entry: interval.entry, lane });
  }

  closeCluster();

  return results;
}

/**
 * The inline position and width a lane resolves to, as CSS `calc()` expressions.
 *
 * Percent for the column's own width, which this file does not know in pixels, and a fixed pixel
 * gutter for the same 4px `inset-x-1` every point already drew with, split so lanes get 2px
 * between them rather than 4px in the middle and none at the edges.
 */
function laneStyle(lane: number, lanes: number): { left: string; width: string } {
  const gap = 2;
  const inset = 4;
  const available = `(100% - ${String(inset * 2)}px - ${String((lanes - 1) * gap)}px)`;

  return {
    left: `calc(${String(inset)}px + (${available}) * ${String(lane)} / ${String(lanes)} + ${String(lane * gap)}px)`,
    width: `calc((${available}) / ${String(lanes)})`,
  };
}

function DayColumn(props: {
  readonly day: CalendarDay;

  /** The column's position in the roving grid: which day Left and Right arrive at. */
  readonly dayIndex: number;
  readonly placed: readonly Placed[];
  readonly dateProperty: string;
  readonly zone: string;
  readonly onOpen: (itemId: string) => void;
  /**
   * Adds an item to the day or slot it is offered on.
   *
   * Optional, and absent means the grid offers no way to create. The collated calendar reads across
   * containers, so "create here" has no answer - there is no one container a new item would belong
   * to. A control that appeared and did nothing would be worse than no control.
   */
  readonly onCreate?:
    ((title: string, properties?: Record<string, unknown>) => Promise<string | null>) | undefined;
  readonly dragged: string | null;
  /**
   * Reschedules an item onto the slot it was dropped on.
   *
   * Optional, and absent means the grid accepts no drops. Paired with `dragged`, which is null for
   * the same caller - a grid that took a drop it could not write would silently discard it.
   */
  readonly onMove?: ((itemId: string, values: Record<string, string | null>) => void) | undefined;

  /**
   * Opens the reschedule dialog for a placed item.
   *
   * Optional in lockstep with `onMove`: a grid that cannot write a reschedule has no business
   * opening a dialog that ends in one.
   */
  readonly onReschedule?: ((itemId: string) => void) | undefined;
}): ReactNode {
  const {
    day,
    dayIndex,
    placed,
    dateProperty,
    zone,
    onOpen,
    onCreate,
    dragged,
    onMove,
    onReschedule,
  } = props;

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

      {layout(placed).map((entry) => {
        const { left, width } = laneStyle(entry.lane, entry.lanes);

        const position = {
          // design-token-exempt: where an item sits, how wide its lane is and how tall its
          // span is are all positions read off the data and the overlap sweep above, computed
          // at runtime rather than restated as a class - see ROW_HEIGHT's own comment.
          top: `${String(minutesToPx(entry.minutes))}px`,
          left,
          width,
          ...(entry.durationMinutes === null
            ? {}
            : {
                // Clamped to MIN_SPAN_HEIGHT_PX - see its own comment - so a span under about
                // thirty-eight minutes still has room for its Reschedule button. The top above
                // stays exact; only a too-short box's bottom moves.
                height: `${String(Math.max(minutesToPx(entry.durationMinutes), MIN_SPAN_HEIGHT_PX))}px`,
                // A short span's box is shorter than its two lines of text. Kept off the
                // Tailwind class list rather than reached for as `overflow-hidden`: this
                // file's own scroller-contract tests scan for anything named `overflow-*`
                // inside the grid to prove there is exactly one scroll boundary, and a class
                // saying "clip my own content" is not a second scroller - but the substring
                // match cannot tell the two apart, so this stays an inline style instead.
                overflow: 'hidden',
              }),
        };
        return (
          // A row rather than a single button: a placed item used to answer only to `onOpen`,
          // which made a drag the sole way to move a card once it had landed on the grid - a
          // gesture neither a keyboard nor a touch screen has. The reschedule control beside it
          // reaches the same write a drag makes, exactly as the month card's own reschedule
          // control does. A span sets an explicit `height`, computed from its duration; a point
          // sets none and draws at its content's own height, exactly as it always has.
          <div
            key={entry.item.id}
            style={position} // design-token-exempt: computed from the data and the overlap sweep
            className="absolute flex items-stretch gap-0.5 rounded-sm bg-accent/18"
          >
            <button
              type="button"
              onClick={() => {
                onOpen(entry.item.id);
              }}
              className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-sm px-1.5 py-1 text-left text-xs hover:bg-accent/25 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
            >
              <span className="truncate font-medium">{readPropertyText(entry.item, 'title')}</span>
              <span className="truncate text-muted">{timeLabel(entry, zone)}</span>
            </button>

            {onReschedule === undefined ? null : (
              <Button
                variant="ghost"
                aria-label={`Reschedule ${readPropertyText(entry.item, 'title') || 'Untitled'}`}
                aria-haspopup="dialog"
                className="shrink-0 self-start px-0.5 py-1"
                onClick={() => {
                  onReschedule(entry.item.id);
                }}
              >
                <Icon icon={CalendarClock} size="sm" />
              </Button>
            )}
          </div>
        );
      })}
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
  /**
   * Adds an item to the day or slot it is offered on.
   *
   * Optional, and absent means the grid offers no way to create. The collated calendar reads across
   * containers, so "create here" has no answer - there is no one container a new item would belong
   * to. A control that appeared and did nothing would be worse than no control.
   */
  readonly onCreate?:
    ((title: string, properties?: Record<string, unknown>) => Promise<string | null>) | undefined;
  readonly dragged: string | null;
  /**
   * Reschedules an item onto the slot it was dropped on.
   *
   * Optional, and absent means the grid accepts no drops. Paired with `dragged`, which is null for
   * the same caller - a grid that took a drop it could not write would silently discard it.
   */
  readonly onMove?: ((itemId: string, values: Record<string, string | null>) => void) | undefined;
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
        if (dragged !== null && onMove !== undefined) {
          // The hour is the whole point of dropping here rather than on a day: a drop writes the
          // moment the slot stands for, in the reader's zone, through the same function the slot's
          // create control writes.
          onMove(dragged, { [dateProperty]: writeSlot(day, hour, zone) });
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
          the same reasoning, on workspace-sidebar.tsx's row-hover controls.
          `pointer-coarse:*` keeps it shown and tappable on a phone, which has no hover and no way
          to tab through 168 slots to focus one - the same trio workspace-sidebar.tsx's row
          controls and drive-view.tsx's own touch target already use. */}
      {onCreate !== undefined && (
        <CreateItemControl
          compact
          label={`Add an item at ${at} on ${dayLabel(day)}`}
          properties={{ [dateProperty]: writeSlot(day, hour, zone) }}
          onCreate={onCreate}
          className="opacity-0 pointer-events-none focus-within:pointer-events-auto focus-within:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/slot:pointer-events-auto group-hover/slot:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100"
        />
      )}
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
  /**
   * Adds an item to the day or slot it is offered on.
   *
   * Optional, and absent means the grid offers no way to create. The collated calendar reads across
   * containers, so "create here" has no answer - there is no one container a new item would belong
   * to. A control that appeared and did nothing would be worse than no control.
   */
  readonly onCreate?:
    ((title: string, properties?: Record<string, unknown>) => Promise<string | null>) | undefined;
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
                control above for why `visibility: hidden` breaks the keyboard path entirely.
                `pointer-coarse:*` keeps it shown and tappable on a phone, for the same reason as
                the hour cell's own control. */}
            {onCreate !== undefined && (
              <CreateItemControl
                compact
                label={`Add an all-day item on ${dayLabel(day)}`}
                properties={{ [dateProperty]: wanted }}
                onCreate={onCreate}
                className="opacity-0 pointer-events-none focus-within:pointer-events-auto focus-within:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/allday:pointer-events-auto group-hover/allday:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100"
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
