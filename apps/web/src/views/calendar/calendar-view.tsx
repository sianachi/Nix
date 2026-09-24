import { useNarrowViewport } from '../../layout/viewport';
import { Blueprint, Button, Icon, Text, cn } from '@nix/ui';
import { CalendarClock, ChevronLeft, ChevronRight } from 'lucide-react';
import { useId, useState, type DragEvent, type ReactNode } from 'react';

import {
  readDateValue,
  type ContainerViews,
  type EffectiveSchema,
  type Item,
  type PropertyDefinition,
  type PropertyValue,
  type View,
} from '../core/container-model';
import { CreateItemControl } from '../core/create-item-control';
import {
  addDays,
  dayFromText,
  dayLabel,
  dayText,
  daysInMonth,
  monthEntry,
  monthLabel,
  monthPrefix,
  shiftMonth,
  weekdayIndex,
  weekLabel,
  weekOf,
  WEEKDAY_ABBREVIATIONS,
  type CalendarDay,
  type CalendarMonth,
} from '../core/calendar-dates';
import { HourGrid } from './calendar-hours';
import { MonthGrid, type DayCellSpec } from './month-grid';
import { RescheduleDialog } from './reschedule-dialog';
import { VIEW_GUTTER_BLEED } from '../core/view-gutter';
import { dayFor, readTimestampValue, readerZone } from '../core/timestamps';
import type { ContainerData } from '../core/use-container';
import { drawable, undrawable, useViewChrome } from '../core/view-chrome';
import { useViewState } from '../core/view-state';
import { ListCell } from '../list/list-cell';

/**
 * A container's children on a month grid, placed by the view's date property.
 *
 * **Placement is a text comparison, start to finish.** Dates are stored as `yyyy-MM-dd` with no
 * time and no zone precisely so that a property meaning "the 3rd" is the 3rd for everybody, and the
 * moment this file turned one of those strings into a `Date` to decide a cell, it would stop being
 * true: `new Date('2026-03-01')` is UTC midnight, which is the 28th of February for every reader
 * west of Greenwich. So the grid is built from integer arithmetic on the year and month numbers,
 * each cell knows its own `yyyy-MM-dd` text, and an item lands in the cell whose text equals its
 * property. No `Date` is ever constructed from a stored value - the only clock reading in this file
 * is "what is today where this person is sitting", which is a local question and is asked once.
 *
 * **Where an item sits is its date.** Dragging a card to a day and using the per-item reschedule
 * control do the same single thing: write the date property. Nothing about placement is view-local,
 * so two people looking at the same folder through different views cannot disagree about when
 * something is due.
 *
 * **The keyboard path is not a courtesy.** A calendar whose only way to move an item is a drag is a
 * calendar a person using a keyboard or a screen reader cannot operate at all, so every card
 * carries a reschedule control that reaches the same write.
 *
 * **An item with an `endDateProperty` covers every day between the two, drawn on each one**
 * (`spanDates`), rather than only on its start day with a marker saying it continues. A month
 * cell is already a list of cards, not a single-line row a bar could stretch across the way
 * timeline-view.tsx draws one, so showing the same card again on every covered day costs this
 * file one loop and no new layout, and is the one rendering that agrees with "where an item sits
 * is its date" above for a date range rather than a single date.
 */

export interface CalendarViewProps {
  readonly container: ContainerData;
  readonly view: View;

  /** Opens an item. A callback rather than a router import: this component does not own routing. */
  readonly onOpen: (itemId: string) => void;
}

/**
 * Today, in the reader's own zone.
 *
 * The one place a clock is read, and the one place local time is the right question: "today" is
 * where the person is sitting, not where the server is. The result is immediately turned into month
 * numbers and `yyyy-MM-dd` text, so nothing downstream handles an instant.
 */
function today(): { readonly month: CalendarMonth; readonly text: string } {
  const now = new Date();
  const month = { year: now.getFullYear(), month: now.getMonth() };
  return { month, text: dayText({ ...month, day: now.getDate() }) };
}

/** Today as a whole day, which is what week and day modes anchor on. */
function todayDay(): CalendarDay {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth(), day: now.getDate() };
}

/** The three grains, with anything unrecognised falling back to the one every view had. */
function readMode(value: string | null): 'month' | 'week' | 'day' {
  return value === 'week' || value === 'day' ? value : 'month';
}

/** A month, abbreviated to three letters, in the order `MONTH_NAMES` names them. */
const MONTH_ABBREVIATIONS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/**
 * A `yyyy-MM-dd` date, said the way the rest of the calendar says a day when the sentence has room
 * for one but not for `dayLabel`'s full spelling: a weekday and a month abbreviated, as
 * `month-grid.tsx`'s header row and `timeline-scale.ts`'s own compact column already abbreviate
 * theirs. The agenda used to print the stored text verbatim - "2026-09-24" - which is the one date
 * shape nobody reading a calendar actually thinks in.
 *
 * Falls back to the raw text on a date this cannot parse, which should not happen for a key already
 * used to bucket the agenda, but a heading that could throw is worse than one that is occasionally
 * literal.
 */
function agendaDayLabel(date: string): string {
  const day = dayFromText(date);
  if (day === null) {
    return date;
  }

  const weekday = monthEntry(WEEKDAY_ABBREVIATIONS, weekdayIndex(day.year, day.month, day.day));
  return `${weekday} ${String(day.day)} ${monthEntry(MONTH_ABBREVIATIONS, day.month)}`;
}

const NO_DATE_PROPERTY =
  'A calendar places items by a date property, and this view does not name one. Nothing has been ' +
  'lost - every item is still here, and a list or board view will show them.';

/**
 * Why this calendar cannot be drawn, or null when it can.
 *
 * An empty month and a broken month look identical, so the difference has to be stated. Core's own
 * `unrenderable` list is consulted first because it is the authority on a view whose configuration
 * has drifted; the schema check catches the same drift locally when Core has not flagged it.
 */
function describeUnrenderable(
  view: View,
  schema: EffectiveSchema | null,
  views: ContainerViews | null,
): string | null {
  if (views?.unrenderable.includes(view.id) === true) {
    return `Core reports that "${view.name}" can no longer be drawn: the property it placed items by is gone or no longer fits. The items are untouched, and another view will show them.`;
  }

  if (view.dateProperty === null) {
    return NO_DATE_PROPERTY;
  }

  // A container with no schema - a workspace root - cannot be checked, and refusing to draw on that
  // basis would call a perfectly good calendar broken. The values are still validated as they are
  // read, so an item carrying something that is not a date lands in "unscheduled" rather than in a
  // wrong cell.
  if (schema === null) {
    return null;
  }

  const definition = schema.properties.find((property) => property.key === view.dateProperty);

  if (definition === undefined) {
    return `This calendar places items by "${view.dateProperty}", and that property is not in this item's schema. It was probably removed. The items are all still here; a list view will show them.`;
  }

  // Both, because both name a day. A date is an all-day thing that must not shift for a reader in
  // another zone; a timestamp is a moment that must, and carries an hour as well.
  if (definition.type !== 'date' && definition.type !== 'timestamp') {
    return `This calendar places items by "${definition.label}", which is a ${definition.type} property rather than a date or a time. There is no day to put an item on, so nothing can be drawn.`;
  }

  return null;
}

export function CalendarView(props: CalendarViewProps): ReactNode {
  const { container, view, onOpen } = props;
  const narrow = useNarrowViewport();
  const [showGrid, setShowGrid] = useState(false);
  const viewState = useViewState();
  const { mode: urlMode, setMode } = viewState;

  /*
   * Which month is on screen is local state, and deliberately not in the URL.
   *
   * The URL carries what somebody decided about the data - which view, sorted how, filtered to
   * what - because those are the things a person means to send when they paste a link. The month is
   * not one of them: it is a scroll position through time. Putting it in the URL would freeze every
   * recipient of every link on whichever month the sender happened to have paged to, so a link
   * shared in March would still open on March in June, and the reader would have to notice and
   * correct it before believing anything on the screen.
   */
  const [anchor, setAnchor] = useState<CalendarDay>(todayDay);
  const month: CalendarMonth = { year: anchor.year, month: anchor.month };

  function setMonth(next: CalendarMonth | ((current: CalendarMonth) => CalendarMonth)): void {
    setAnchor((current) => {
      const asMonth = { year: current.year, month: current.month };
      const chosen = typeof next === 'function' ? next(asMonth) : next;

      // Clamped, because the 31st does not exist in every month and an anchor that fell off the end
      // would silently roll into the next one.
      return {
        ...chosen,
        day: Math.min(current.day, daysInMonth(chosen)),
      };
    });
  }
  const [dragged, setDraggedState] = useState<{
    readonly id: string;
    readonly from: string | null;
  } | null>(null);

  function setDragged(itemId: string, occurrenceDate: string | null): void {
    setDraggedState({ id: itemId, from: occurrenceDate });
  }
  const [rescheduling, setRescheduling] = useState<string | null>(null);
  const unscheduledHeadingId = useId();

  const reason = describeUnrenderable(view, container.schema, container.views);
  const configured = view.dateProperty;

  const chrome = useViewChrome({
    container,
    viewState,
    subject: 'this calendar',
    drawable:
      configured === null || reason !== null
        ? undrawable<string>({
            title: 'This calendar cannot be drawn',
            detail: reason ?? NO_DATE_PROPERTY,
          })
        : drawable(configured),
    emptyTitle: 'Nothing in here yet',
    emptyDetail:
      'There is nothing to place on a calendar yet. Items added to this one will appear on the day their date says.',
    // Made without a date, so it lands in the unscheduled list rather than on a day nobody picked.
    emptyAction: <CreateItemControl label="Add the first item" onCreate={container.create} />,
    filtered: (total) => ({
      title: 'No items match the current filters',
      detail: `This holds ${String(total)} items, and the filters in the address hide every one of them. Clearing the filters brings them back.`,
    }),
    // A calendar is ordered by the grid, not by a column header: within a day, items keep the order
    // somebody arranged them in.
    sortBy: null,
    descending: false,
  });

  if (chrome.kind === 'chrome') {
    return chrome.node;
  }

  // Named with its type stated so the closures below see a key rather than a maybe-key: a narrowing
  // does not follow a `const` into a function that is created later in the body.
  const dateProperty: string = chrome.drawable;
  const items = chrome.items;

  // Read before the buckets are filled, because which day a timestamp falls on is a question about
  // the reader, not about the value.
  const zone = readerZone();

  // Whether this calendar places by a moment or by a day, which decides what the reschedule dialog
  // has to be able to type. A container with no schema cannot be asked, and a bare date is the
  // safer assumption: it is what the month grid and every existing stored value already use.
  const placesByTime =
    container.schema?.properties.find((property) => property.key === dateProperty)?.type ===
    'timestamp';

  // The view's own end-of-span property, when it has one - see `RescheduleDialogProps.endDateProperty`
  // for why the calendar's end field assumes the same shape as `dateProperty` rather than checking
  // its own type against the schema. Read before the buckets are filled: a multi-day item's own
  // bucketing below needs it.
  const endDateProperty = view.endDateProperty;

  const byDate = new Map<string, Item[]>();
  const unscheduled: Item[] = [];

  for (const item of items) {
    const value = readDayValue(item, dateProperty, zone);

    if (value === null) {
      // Never dropped. An item with no date is an item somebody has not scheduled yet, and a
      // calendar that silently omits it is a calendar that loses half a folder without saying so.
      unscheduled.push(item);
      continue;
    }

    // An item with an end that lands after its start covers every day in between, and this grid
    // shows it on each of them - the same "where an item sits is its date" rule extended across a
    // range rather than a single answer. An end on or before the start (no end configured, none
    // set on this item, or one that lands before its start - the reversed span timeline-view.tsx
    // also refuses to draw) collapses to the single-day case every calendar has always had.
    const end = endDateProperty === null ? null : readDayValue(item, endDateProperty, zone);
    const dates = end === null || end <= value ? [value] : spanDates(value, end);

    for (const date of dates) {
      const existing = byDate.get(date);
      if (existing === undefined) {
        byDate.set(date, [item]);
      } else {
        existing.push(item);
      }
    }
  }

  const prefix = monthPrefix(month);

  // Counted by item, not by bucket: a multi-day item now occupies one bucket per day it covers,
  // and a bucket outside this month it also reaches on some other day is not an item that has
  // gone missing from the calendar - it is right there, drawn on the day that is in view.
  const inMonth = new Set<string>();
  const outsideMonth = new Set<string>();
  for (const [date, dated] of byDate) {
    for (const dayItem of dated) {
      (date.startsWith(prefix) ? inMonth : outsideMonth).add(dayItem.id);
    }
  }
  let elsewhere = 0;
  for (const id of outsideMonth) {
    if (!inMonth.has(id)) {
      elsewhere += 1;
    }
  }

  // The first configured column that is neither the title nor the date: what a card can usefully
  // say about itself in the two centimetres a day cell affords.
  const secondaryKey = view.columns.find((key) => key !== dateProperty && key !== 'title') ?? null;
  const secondaryProperty =
    secondaryKey === null
      ? null
      : (container.schema?.properties.find((property) => property.key === secondaryKey) ?? null);

  function moveTo(itemId: string, values: Record<string, string | null>): void {
    void container.setProperties(itemId, values);
    setRescheduling(null);
    setDraggedState(null);
  }

  /**
   * What a drop onto a day writes: the whole span shifted together when the item has one, or just
   * the date property when it does not - see `CardContext.dropOnDate`'s own note for why.
   */
  function dropOnDate(itemId: string, from: string | null, to: string): void {
    if (from !== null && from !== to && endDateProperty !== null) {
      const item = items.find((entry) => entry.id === itemId);
      const start = item === undefined ? null : readDayValue(item, dateProperty, zone);
      const end = item === undefined ? null : readDayValue(item, endDateProperty, zone);

      if (start !== null && end !== null && end > start) {
        const delta = daysBetween(from, to);
        const shiftedStart = delta === null ? null : shiftDateText(start, delta);
        const shiftedEnd = delta === null ? null : shiftDateText(end, delta);

        if (shiftedStart !== null && shiftedEnd !== null) {
          moveTo(itemId, { [dateProperty]: shiftedStart, [endDateProperty]: shiftedEnd });
          return;
        }
      }
    }

    moveTo(itemId, { [dateProperty]: to });
  }

  /** What a drop into the unscheduled list, or the dialog's own "Remove date", both write. */
  function clearedDate(): Record<string, string | null> {
    return endDateProperty === null
      ? { [dateProperty]: null }
      : { [dateProperty]: null, [endDateProperty]: null };
  }

  const card: CardContext = {
    onOpen,
    setRescheduling,
    setDragged,
    clearDragged: () => {
      setDraggedState(null);
    },
    moveTo,
    dropOnDate,
    dateProperty,
    secondaryKey,
    secondaryProperty,
    onWrite: (itemId: string, propertyKey: string, value: PropertyValue) =>
      container.setProperties(itemId, { [propertyKey]: value }),
    onCreate: container.create,
  };

  // The item the reschedule dialog is open for, resolved from the id rather than stored as an
  // item: the id survives the item's own data changing under it, and a stale copy would show a
  // date the grid no longer agrees with.
  const reschedulingItem =
    rescheduling === null ? null : (items.find((item) => item.id === rescheduling) ?? null);

  // One clock reading for the whole grid rather than one per cell: the answer cannot change
  // halfway through a render, and forty-two of them would be forty-two allocations for one fact.
  const todayText = today().text;

  // The view's own grain, overridable by the address the way the view itself is - a link saying
  // "look at this week" should open on a week.
  const mode = readMode(urlMode ?? view.mode);

  /** One step of whatever is on screen: a month, a week, or a day. */
  function step(delta: number): void {
    if (mode === 'month') {
      setMonth(shiftMonth(month, delta));
      return;
    }

    setAnchor((current) => addDays(current, delta * (mode === 'week' ? 7 : 1)));
  }

  return (
    // gap-3, matching the board's, the gallery's and the timeline's own root wrapper: all four are
    // the same shape - an optional error, a header row, then the view's content - and this was the
    // one drawn one step further apart than the rest for no stated reason.
    <div className="flex flex-col gap-3">
      {container.writeError === null ? null : (
        // Alongside the calendar rather than instead of it: the write was refused and the item has
        // already been put back where it was, so the grid is correct and only the reason is missing.
        <div role="alert" className="border border-divider p-3">
          <Text variant="bodySmall">{container.writeError}</Text>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Text variant="h4" as="h2">
          {mode === 'month'
            ? monthLabel(month)
            : mode === 'week'
              ? weekLabel(anchor)
              : dayLabel(anchor)}
        </Text>

        {/* aria-current rather than a tablist, following the view switcher: these are three ways of
            looking at one thing, and claiming to be tabs would owe arrow-key navigation nobody
            asked for. */}
        <nav aria-label="Calendar grain" className="flex items-center gap-0.5">
          {(['month', 'week', 'day'] as const).map((grain) => (
            <button
              key={grain}
              type="button"
              aria-current={mode === grain ? 'page' : undefined}
              onClick={() => {
                setMode(grain);
              }}
              className={[
                // `relative before:*`: the drawn pill is about 22px tall (`text-xs` at its 1.4
                // line height plus `py-1`), just under WCAG 2.5.8's 24px floor. The pseudo-element
                // widens the hit area half a step past each edge without moving the row - the
                // pane-divider technique, at the smallest extension that clears the floor.
                'relative rounded-sm px-2 py-1 text-xs capitalize before:absolute before:inset-x-0 before:-inset-y-0.5',
                'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
                mode === grain
                  ? 'bg-foreground/7 text-foreground'
                  : 'text-muted hover:bg-foreground/7 hover:text-foreground',
              ].join(' ')}
            >
              {grain}
            </button>
          ))}
        </nav>

        {/* Always visible, never gated behind a hover. The agenda is the default on a phone and
            had no way to add anything at all until a day's own control was reached below - this
            is the one that is reachable the moment the calendar opens, made without a date the
            same way "Add the first item" is on an empty calendar. */}
        <CreateItemControl label="Add an item" onCreate={container.create} />

        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            aria-label={`Previous ${mode}`}
            className="px-2"
            onClick={() => {
              step(-1);
            }}
          >
            <Icon icon={ChevronLeft} size="sm" />
          </Button>

          <Button
            variant="secondary"
            className="py-1"
            onClick={() => {
              setAnchor(todayDay());
            }}
          >
            Today
          </Button>

          <Button
            variant="ghost"
            aria-label={`Next ${mode}`}
            className="px-2"
            onClick={() => {
              step(1);
            }}
          >
            <Icon icon={ChevronRight} size="sm" />
          </Button>
        </div>
      </div>

      {/* What the address is hiding, said separately from what the grid is: one is a filter
          somebody set, the other is a month somebody paged away from. */}
      {chrome.notice}

      {elsewhere === 0 ? null : (
        // A month grid can only show a month. Saying how much is off-screen is the difference
        // between a calendar and a calendar that appears to have lost things.
        <div role="status">
          <Text variant="caption" tone="muted">
            {elsewhere === 1
              ? `1 item is dated outside ${monthLabel(month)}.`
              : `${String(elsewhere)} items are dated outside ${monthLabel(month)}.`}
          </Text>
        </div>
      )}

      {narrow ? (
        <Button
          variant="ghost"
          aria-pressed={showGrid}
          onClick={() => {
            setShowGrid(!showGrid);
          }}
        >
          {showGrid ? 'Show agenda' : 'Show calendar grid'}
        </Button>
      ) : null}
      {narrow && !showGrid ? (
        <section aria-label="Calendar agenda" className="flex flex-col gap-4">
          {[...byDate]
            .filter(([date]) =>
              mode === 'month'
                ? date.startsWith(prefix)
                : (mode === 'week' ? weekOf(anchor) : [anchor]).some(
                    (day) => dayText(day) === date,
                  ),
            )
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, dated]) => (
              <section key={date} aria-label={agendaDayLabel(date)}>
                <Text as="h3" variant="h6">
                  {agendaDayLabel(date)}
                </Text>
                <ul className="flex flex-col gap-2">
                  {dated.map((item) => (
                    <li key={item.id}>
                      <ItemCard item={item} card={card} occurrenceDate={date} />
                    </li>
                  ))}
                </ul>

                {/* Always visible - this is the agenda's own per-day add, and the agenda is the
                    view a phone opens on. The month grid's equivalent control can afford to wait
                    for a hover or a focus because a pointer that can hover a cell can also reach
                    the toolbar's control above; a phone has neither, so this one does not hide. */}
                <CreateItemControl
                  label={`Add an item on ${agendaDayLabel(date)}`}
                  properties={{ [card.dateProperty]: date }}
                  onCreate={card.onCreate}
                  className="mt-1 self-start"
                />
              </section>
            ))}
          <Text as="p" variant="caption" tone="muted">
            Only scheduled items in this date window appear here.
          </Text>
        </section>
      ) : mode === 'month' ? (
        <MonthGrid
          month={month}
          todayText={todayText}
          prefix={prefix}
          // The container's gutter is bled into the scroller so those pixels belong to the scroll
          // viewport rather than to the chrome around it - `VIEW_GUTTER_BLEED` owns the negative
          // margin and the padding together, so the two cannot become different numbers. The
          // collated calendar has no gutter to bleed, which is why this is the caller's to pass.
          regionClassName={VIEW_GUTTER_BLEED}
          renderDay={(cell, name, isToday) => (
            <DayCell
              key={cell.date}
              cell={cell}
              name={name}
              isToday={isToday}
              items={byDate.get(cell.date) ?? []}
              dragged={dragged}
              card={card}
            />
          )}
        />
      ) : (
        <Blueprint className="flex min-h-[520px] flex-col overflow-hidden p-0">
          <HourGrid
            days={mode === 'week' ? weekOf(anchor) : [anchor]}
            items={items}
            dateProperty={dateProperty}
            endDateProperty={endDateProperty}
            zone={zone}
            today={todayText}
            onOpen={onOpen}
            onCreate={container.create}
            dragged={dragged?.id ?? null}
            onMove={moveTo}
          />
        </Blueprint>
      )}

      <section
        aria-labelledby={unscheduledHeadingId}
        onDragOver={(event: DragEvent<HTMLElement>) => {
          event.preventDefault();
        }}
        onDrop={(event: DragEvent<HTMLElement>) => {
          event.preventDefault();
          if (dragged !== null) {
            moveTo(dragged.id, clearedDate());
          }
        }}
        className="flex flex-col gap-2 border border-divider p-3"
      >
        <Text variant="h6" as="h3" id={unscheduledHeadingId}>
          {`Unscheduled (${String(unscheduled.length)})`}
        </Text>

        {unscheduled.length === 0 ? (
          <Text variant="caption" tone="muted">
            Every item in this folder has a date. Dropping a card here takes its date off again.
          </Text>
        ) : (
          <ul className="flex flex-col gap-1">
            {unscheduled.map((item) => (
              <li key={item.id}>
                <ItemCard item={item} card={card} occurrenceDate={null} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* One dialog, rendered at the root, for whichever card asked. It used to be an inline form
          swapped into the card's place, which inside a month cell meant a native date input asked
          to draw itself in a `w-[6.5rem]` column - narrower than the ~120px the control needs, so
          the date being edited was not on screen. Keyed by item so a different card's dialog
          starts with its draft and errors fresh. */}
      {reschedulingItem === null ? null : (
        <RescheduleDialog
          key={reschedulingItem.id}
          item={reschedulingItem}
          dateProperty={dateProperty}
          endDateProperty={endDateProperty}
          placesByTime={placesByTime}
          zone={zone}
          onCancel={() => {
            setRescheduling(null);
          }}
          onMove={(values) => {
            moveTo(reschedulingItem.id, values);
          }}
        />
      )}
    </div>
  );
}

/**
 * The day an item sits on for this reader, whichever shape its date property carries.
 *
 * A `date` is already a day. A `timestamp` is a moment, and which day that falls on depends on who
 * is looking, so it is converted to the reader's zone first - exactly as the hour grid does when it
 * decides which column an item belongs in.
 *
 * **Reading only the plain-date shape here is what used to send every timestamped item to
 * "unscheduled".** That was invisible while nothing could write a time from the interface; the
 * moment an hour slot accepted a drop it became visible immediately, as a card that appeared in the
 * slot it was dropped on and stayed in the unscheduled list underneath.
 */
function readDayValue(item: Item, key: string, zone: string): string | null {
  const plain = readDateValue(item, key);
  if (plain !== null) {
    return plain;
  }

  const moment = readTimestampValue(item.properties, key);
  return moment === null ? null : dayFor(moment, zone);
}

/**
 * The safety valve on a span the interface can only ever have written a sane length: a bound
 * nobody scheduling a real item would reach, so a malformed value cannot turn one item into a
 * year of buckets that cost memory and mean nothing.
 */
const MAX_SPAN_DAYS = 366;

/**
 * Every `yyyy-MM-dd` day from `start` to `end`, inclusive.
 *
 * Called only once `end` is already known to be after `start` - see the loop that builds
 * `byDate`. Falls back to the single start day on a date this cannot parse, which should not
 * happen for text `readDayValue` already produced, but a month grid that could throw on bad data
 * is worse than one that occasionally under-covers a span.
 */
function spanDates(start: string, end: string): readonly string[] {
  const first = dayFromText(start);
  if (first === null) {
    return [start];
  }

  const dates: string[] = [];
  let cursor = first;
  for (let count = 0; count < MAX_SPAN_DAYS; count += 1) {
    const text = dayText(cursor);
    dates.push(text);
    if (text === end) {
      break;
    }
    cursor = addDays(cursor, 1);
  }

  return dates;
}

/**
 * A proleptic-Gregorian day number, counted the way `addDays` counts - as integers, never through
 * a `Date`. This is the one piece of arithmetic that module's helpers do not offer: a distance
 * between two days, rather than a day moved by one. `month` here is 1-12, matching the stored text
 * `dayFromText` already parsed it from, not the 0-11 `CalendarDay` carries.
 *
 * The formula is Howard Hinnant's `days_from_civil`: pure integer arithmetic, correct across every
 * month and year boundary the calendar can reach, and exactly the kind of "no wall clock, no
 * timezone" fact this file's own dates already are.
 */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor((y >= 0 ? y : y - 399) / 400);
  const yoe = y - era * 400;
  const monthIndex = (month + 9) % 12;
  const dayOfYear = Math.floor((153 * monthIndex + 2) / 5) + day - 1;
  const dayOfEra = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/** The number of days from `from` to `to`, negative when `to` is the earlier date. Null on text that isn't a whole calendar day. */
function daysBetween(from: string, to: string): number | null {
  const start = dayFromText(from);
  const end = dayFromText(to);
  if (start === null || end === null) {
    return null;
  }

  return (
    daysFromCivil(end.year, end.month + 1, end.day) -
    daysFromCivil(start.year, start.month + 1, start.day)
  );
}

/** `value`, moved by `delta` days - the text form `spanDates` and every drop already deal in. */
function shiftDateText(value: string, delta: number): string | null {
  const day = dayFromText(value);
  return day === null ? null : dayText(addDays(day, delta));
}

/** What every card needs, whether it sits in a day or in the unscheduled list. */
interface CardContext {
  readonly onOpen: (itemId: string) => void;
  readonly setRescheduling: (itemId: string | null) => void;
  readonly setDragged: (itemId: string, occurrenceDate: string | null) => void;

  /** What a drag that never lands on a target - lifted, then dropped nowhere - clears. */
  readonly clearDragged: () => void;
  readonly moveTo: (itemId: string, values: Record<string, string | null>) => void;

  /**
   * What a drop onto `to` writes for an item last dragged from `from`.
   *
   * `from` is the day the dragged occurrence was drawn on - null when the drag started somewhere
   * with no day of its own (the unscheduled list). When the item has an end configured and set,
   * this shifts both the start and the end by the distance from `from` to `to`, so the whole span
   * moves together rather than just the end the pointer happened to be over - see `spanDates`'s
   * own note on the reversed-span bug this replaces. Anything else - a point item, or a drag with
   * no origin day - falls back to writing only the date property, exactly as before.
   */
  readonly dropOnDate: (itemId: string, from: string | null, to: string) => void;
  readonly secondaryKey: string | null;
  readonly secondaryProperty: PropertyDefinition | null;
  readonly onWrite: (
    itemId: string,
    propertyKey: string,
    value: PropertyValue,
  ) => Promise<string | null>;
  readonly onCreate: (
    title: string,
    properties?: Record<string, unknown>,
  ) => Promise<string | null>;
  readonly dateProperty: string;
}

interface DayCellProps {
  readonly cell: DayCellSpec;

  /** The cell's accessible name: weekday, day, month and year, spelt out. */
  readonly name: string;
  readonly isToday: boolean;
  readonly items: readonly Item[];
  readonly dragged: { readonly id: string; readonly from: string | null } | null;
  readonly card: CardContext;
}

const MAXIMUM_COLLAPSED_DAY_ITEMS = 6;

function DayCell(props: DayCellProps): ReactNode {
  const { cell, name, isToday, items, dragged, card } = props;
  const [over, setOver] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const visibleItems = expanded ? items : items.slice(0, MAXIMUM_COLLAPSED_DAY_ITEMS);
  const hiddenItems = items.length - visibleItems.length;

  return (
    <td
      // The cell's accessible name carries the whole date, so somebody moving through the grid with
      // a screen reader always knows which day they are on rather than hearing a bare "17".
      aria-label={name}
      aria-current={isToday ? 'date' : undefined}
      onDragOver={(event: DragEvent<HTMLTableCellElement>) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => {
        setOver(false);
      }}
      onDrop={(event: DragEvent<HTMLTableCellElement>) => {
        event.preventDefault();
        setOver(false);
        if (dragged !== null) {
          // A drop writes the date property, not a position: where a card sits is its date, and
          // anything view-local would disagree with every other view of the same folder. An item
          // with an end configured and set moves as a whole span - see `CardContext.dropOnDate` -
          // so dragging any day of a multi-day span keeps its length rather than reversing it.
          card.dropOnDate(dragged.id, dragged.from, cell.date);
        }
      }}
      className={cn(
        'group/day h-24 border border-divider align-top',
        isToday ? 'bg-accent/18' : '',
        over && dragged !== null ? 'outline-2 -outline-offset-2 outline-accent' : '',
      )}
    >
      <div className="flex h-full flex-col gap-1 p-1">
        <Text variant="caption" as="span" tone={isToday ? 'accent' : 'muted'}>
          {String(cell.day)}
        </Text>

        {items.length === 0 ? null : (
          <ul className="flex flex-col gap-1">
            {visibleItems.map((item) => (
              <li key={item.id}>
                <ItemCard item={item} card={card} occurrenceDate={cell.date} />
              </li>
            ))}
          </ul>
        )}

        {items.length <= MAXIMUM_COLLAPSED_DAY_ITEMS ? null : (
          <Button
            variant="ghost"
            className="self-start px-1 py-0.5 text-xs"
            aria-expanded={expanded}
            onClick={() => {
              setExpanded((current) => !current);
            }}
          >
            {expanded ? 'Show fewer' : `Show ${String(hiddenItems)} more`}
          </Button>
        )}

        {/* Created already dated to this day - the same write a drop onto it makes. Revealed on
            hover and on focus, following the tree's delete control: forty-two always-visible
            buttons would be more plus signs than calendar, but one that only exists for a pointer
            would be a way to add things that a keyboard does not have.
            `opacity-0`/`pointer-events-none`, not `invisible` - see calendar-hours.tsx's hour-slot
            and all-day controls for why `visibility: hidden` breaks the keyboard path entirely.
            `pointer-coarse:*` keeps it shown and tappable on a phone, which has neither hover nor
            focus-by-tab to reveal it with - the same trio `workspace-sidebar.tsx`'s row controls
            and `drive-view.tsx`'s own touch target already use. */}
        <CreateItemControl
          compact
          label={`Add an item on ${name}`}
          properties={{ [card.dateProperty]: cell.date }}
          onCreate={card.onCreate}
          className="opacity-0 pointer-events-none mt-auto self-start focus-within:pointer-events-auto focus-within:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/day:pointer-events-auto group-hover/day:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100"
        />
      </div>
    </td>
  );
}

interface ItemCardProps {
  readonly item: Item;
  readonly card: CardContext;

  /**
   * The day this card is drawn on right now, or null when it has none - the unscheduled list.
   * A multi-day span is drawn once per day it covers, so the same item's card carries a different
   * value here on each of them; `card.dropOnDate` uses it to tell which day of the span the drag
   * actually started from.
   */
  readonly occurrenceDate: string | null;
}

function ItemCard(props: ItemCardProps): ReactNode {
  const { item, occurrenceDate } = props;
  const { onOpen, setRescheduling, setDragged, clearDragged, secondaryProperty, onWrite } =
    props.card;

  return (
    <div
      draggable
      onDragStart={(event: DragEvent<HTMLDivElement>) => {
        setDragged(item.id, occurrenceDate);
        event.dataTransfer.effectAllowed = 'move';
        // Set although nothing reads it: without data attached, Firefox refuses to start the drag.
        event.dataTransfer.setData('text/plain', item.id);
      }}
      onDragEnd={() => {
        clearDragged();
      }}
      className="flex items-start gap-1 border border-divider bg-surface px-1"
    >
      <div className="flex min-w-0 flex-1 flex-col">
        {/* `before:-inset-x-0.5`: the control keeps `<Button>`'s 36px height, but with `px-0` its
            width is its text's, and a one- or two-character title lands under WCAG 2.5.8's 24px
            floor. Half a step each side is the widest the hit area can grow without reaching the
            reschedule control's own widened area beside it. */}
        <Button
          variant="ghost"
          className="relative min-w-0 justify-start px-0 py-0.5 text-left text-sm before:absolute before:inset-y-0 before:-inset-x-0.5"
          onClick={() => {
            onOpen(item.id);
          }}
        >
          <span className="truncate">{item.title || 'Untitled'}</span>
        </Button>

        {secondaryProperty === null ? null : (
          <div className="min-w-0">
            <Text variant="kicker" tone="muted" as="span">
              {secondaryProperty.label}
            </Text>
            <ListCell
              item={item}
              property={secondaryProperty}
              tabIndex={-1}
              onWrite={(value) => onWrite(item.id, secondaryProperty.key, value)}
            />
          </div>
        )}
      </div>

      {/* `before:-inset-x-1`: with `px-0` this is an 18px-wide target - the 16px glyph plus the
          hairline borders - under the 24px floor, and giving the padding back would cost the day
          cell width it does not have. One spacing step each side clears the floor invisibly, the
          pane-divider technique again. */}
      <Button
        variant="ghost"
        aria-label={`Reschedule ${item.title || 'Untitled'}`}
        aria-haspopup="dialog"
        className="relative px-0 py-0.5 before:absolute before:inset-y-0 before:-inset-x-1"
        onClick={() => {
          setRescheduling(item.id);
        }}
      >
        <Icon icon={CalendarClock} size="sm" />
      </Button>
    </div>
  );
}
