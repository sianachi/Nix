import { Blueprint, Button, Icon, Text, cn, focusRing } from '@nix/ui';
import { CalendarClock, ChevronLeft, ChevronRight } from 'lucide-react';
import { useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';

import { PartialNotice } from '../../components/states/status-panels';
import { PropertyInput } from '../../properties/property-input';
import { dayFromText, dayLabel, dayText, type CalendarDay } from '../core/calendar-dates';
import {
  readPropertyText,
  type ContainerViews,
  type EffectiveSchema,
  type Item,
  type PropertyDefinition,
  type PropertyValue,
  type View,
} from '../core/container-model';
import { CreateItemControl } from '../core/create-item-control';
import { propertyTypeWord, isDateShaped } from '../core/property-types';
import {
  buildWindow,
  placeSpan,
  readDayValue,
  readScale,
  stepAnchor,
  type TimelineColumn,
  type TimelinePlacement,
  type TimelineScale,
  type TimelineWindow,
} from './timeline-scale';
import { readerZone } from '../core/timestamps';
import { drawable, undrawable, useViewChrome } from '../core/view-chrome';
import type { ViewRendererProps } from '../core/view-kinds';
import { useViewState } from '../core/view-state';
import { useVirtualWindow } from '../core/use-virtual-window';
import { virtualSpacers } from '../core/virtual-window';

const VIRTUALIZATION_THRESHOLD = 100;
const ESTIMATED_TIMELINE_ROW_HEIGHT = 45;
const MAXIMUM_COLLAPSED_OFF_AXIS_ITEMS = 20;

/**
 * A container's children as bars across a time axis, placed by a start date and an optional end.
 *
 * **All of the arithmetic is in `timeline-scale.ts` and none of it is here.** Which column a day
 * falls in, how many columns a quarter takes, and whether a span misses the window entirely are
 * questions that can be asked directly of that module; asked of this one they could only be
 * answered by counting cells on a rendered screen. Nothing in this file constructs a `Date` from a
 * stored value, for the reason the calendar's header sets out at length: `new Date('2026-03-01')`
 * is UTC midnight, which is the previous day for every reader west of Greenwich.
 *
 * **The start is `dateProperty` - the calendar's field, under the calendar's name.** That is what
 * makes switching a view between calendar and timeline lossless, and it is why there is no
 * `startDateProperty` anywhere in the system. The end is a second field and is genuinely optional.
 *
 * **Five things can be true of an item that a bar cannot draw, and each gets its own sentence**,
 * because collapsing any two of them puts something untrue on the screen:
 *
 *   - *A start and no end.* A milestone: a marker on the start day. Not a zero-width bar, and
 *     emphatically not a bar drawn to today - extending it would invent an end date nobody entered,
 *     and it would grow every morning.
 *   - *An end before its start.* Neither swapped nor clamped. It is stated in a band below the
 *     grid, showing both dates, with the same reschedule control the bars have. Swapping would
 *     silently correct a data error somebody may need to see; the server does not refuse the pair
 *     either, because two independent property writes cannot both be valid at every instant.
 *   - *Entirely outside the window.* Counted above the grid and listed below it, so it stays
 *     reachable. A window is a scroll position through time and an item is not less real for being
 *     off it. A bar that only partly overlaps is drawn clipped, with a marker at the cut end - and
 *     its accessible name carries the dates it really has, never the ones it was truncated to.
 *   - *No start at all.* The unscheduled list, exactly as the calendar keeps one. A timeline that
 *     dropped undated items would lose half a folder without saying so.
 *   - *A start that is not a date.* Its own band, and told apart from the one above deliberately.
 *     Retyping a text property to Date does not revalidate what is already stored, so `starts:
 *     "next Tuesday"` is reachable, and filing it under "no start date yet" would send somebody
 *     looking for a value that is sitting right there. `PropertyInput` already refuses to overwrite
 *     such a value; this refuses to misdescribe it.
 *
 * **The bars are read-only in this build, and the keyboard path is the only path.** There is no
 * drag-a-range primitive anywhere in this application - the board and the calendar's month grid
 * both drag a *point*, and the hour grid has no drag at all - and a range needs pointer capture, a
 * ghost, snap-to-day arithmetic and an edge-versus-body hit test. That is a goal of its own. Both
 * views that do have a drag also have keyboard parity, so shipping a drag here without one would be
 * the first break in that pattern. What ships instead is the reschedule disclosure every item
 * carries, which reaches the same two writes a drag eventually will.
 *
 * **There is no `writeError` banner here, and that is a decision rather than an omission.**
 * `useContainer` answers a refused write on two channels - the returned reason, and the
 * `writeError` field - and its contract says a caller reads one and never both. The second exists
 * for a gesture nobody awaits: a dragged card has already snapped back and is not a place to put a
 * sentence. Every write this view makes is awaited, so the refusal goes in the field that caused
 * it, and a banner as well would say the same thing twice in two places at once.
 */

export function TimelineView(props: ViewRendererProps): ReactNode {
  const { container, view, onOpen } = props;
  const viewState = useViewState();
  const { mode: urlMode, setMode } = viewState;

  /*
   * Which stretch of time is on screen is local state, and deliberately not in the URL.
   *
   * The address carries what somebody decided about the data - which view, at what grain, sorted
   * how, filtered to what - because those are the things a person means to send when they paste a
   * link. The window is not one of them: it is a scroll position through time. In the address, a
   * link shared in March would still open on March in June, and every recipient would have to
   * notice and correct it before believing anything on the screen. The grain *is* in the address,
   * for the opposite reason: "look at this quarter" is a decision worth sending.
   */
  const [anchor, setAnchor] = useState<CalendarDay>(todayDay);
  const [rescheduling, setRescheduling] = useState<string | null>(null);
  const panelId = useId();

  const reason = describeUndrawable(view, container.schema, container.views);

  const chrome = useViewChrome({
    container,
    viewState,
    subject: 'this timeline',
    drawable:
      view.dateProperty === null || reason !== null
        ? undrawable<string>({
            title: 'This timeline cannot be drawn',
            detail: reason ?? NO_START_PROPERTY,
          })
        : drawable(view.dateProperty),
    emptyTitle: 'Nothing in here yet',
    emptyDetail:
      'There is nothing to put on a timeline yet. Items added to this one appear on the days their dates name.',
    // Made without dates, so it lands in the unscheduled list rather than on a day nobody picked.
    emptyAction: <CreateItemControl label="Add the first item" onCreate={container.create} />,
    filtered: (total) => ({
      title: 'No items match the current filters',
      detail:
        total === 1
          ? 'This holds one item, and the filters in the address hide it. Clearing the filters brings it back.'
          : `This holds ${String(total)} items, and the filters in the address hide every one of them. Clearing the filters brings them back.`,
    }),
    // Rows, unlike calendar cells, are a list and have an order worth choosing - so a sort in the
    // address or on the view decides it, and sibling order is what somebody arranged by hand when
    // neither says anything. The calendar pins this to null because a day cell is not a list.
    sortBy: viewState.sortBy ?? view.sortBy,
    descending:
      viewState.sortBy === null ? view.sortDescending : viewState.direction === 'descending',
  });

  if (chrome.kind === 'chrome') {
    return chrome.node;
  }

  // Named with its type stated so the closures below see a key rather than a maybe-key: a narrowing
  // does not follow a `const` into a function created later in the body.
  const startKey: string = chrome.drawable;
  const endKey: string | null = view.endDateProperty;

  // The view's own grain, overridable by the address the way the view itself is - a link saying
  // "look at this quarter" should open on a quarter. A grain left behind by a calendar that this
  // view has no meaning for falls back rather than being refused; see `readScale`.
  const scale = readScale(urlMode ?? view.mode);

  // `axis`, never `window`: a local called `window` shadows the DOM global for the whole of this
  // function body, and `window.name` and `window.length` both type-check against the wrong object.
  const axis = buildWindow(scale, anchor);
  const zone = readerZone();

  const placed = chrome.items.map((item) => place(item, startKey, endKey, zone, axis));

  const rows = placed.filter(
    (entry) => entry.placement.kind === 'span' || entry.placement.kind === 'milestone',
  );
  const reversed = placed.filter((entry) => entry.placement.kind === 'reversed');
  const outside = placed.filter((entry) => entry.placement.kind === 'outside');

  // Told apart on the raw value rather than on the placement, because the placement cannot see the
  // difference: `readDayValue` returns null both for a property nobody has filled in and for one
  // holding something that is not a date.
  const undated = placed.filter((entry) => entry.placement.kind === 'undated' && !entry.unreadable);
  const unreadable = placed.filter((entry) => entry.unreadable);

  const todayText = dayText(todayDay());
  const lostEnd = describeLostEndProperty(view, container.schema);

  const open = rescheduling === null ? null : (placed.find(byId(rescheduling)) ?? null);

  const aside: AsideContext = {
    onOpen,
    rescheduling,
    setRescheduling,
    panelId,
    schema: container.schema,
    startKey,
    endKey,
    setProperties: container.setProperties,
  };

  return (
    // `min-h-0 flex-1` so the pane keeps the vertical axis: the wide axis is this view's and is
    // owned by the track below, and a second vertical scroller here would compete with the pane's.
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Text variant="h4" as="h2">
          {axis.label}
        </Text>

        {/* aria-current rather than a tablist, following the calendar and the view switcher: these
            are three ways of looking at one thing, and claiming to be tabs would owe arrow-key
            navigation nobody asked for. */}
        <nav aria-label="Timeline scale" className="flex items-center gap-0.5">
          {SCALES.map((grain) => (
            <button
              key={grain}
              type="button"
              aria-current={scale === grain ? 'page' : undefined}
              onClick={() => {
                setMode(grain);
              }}
              className={cn(
                // `relative before:*`: the drawn pill is about 22px tall (`text-xs` at its 1.4
                // line height plus `py-1`), just under WCAG 2.5.8's 24px floor - the same fix,
                // for the same control, as the calendar's grain switcher.
                'relative rounded-sm px-2 py-1 text-xs capitalize before:absolute before:inset-x-0 before:-inset-y-0.5',
                focusRing,
                scale === grain
                  ? 'bg-foreground/7 text-foreground'
                  : 'text-muted hover:bg-foreground/7 hover:text-foreground',
              )}
            >
              {grain}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            aria-label={`Previous ${scale}`}
            className="px-2"
            onClick={() => {
              setAnchor((current) => stepAnchor(scale, current, -1));
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
            aria-label={`Next ${scale}`}
            className="px-2"
            onClick={() => {
              setAnchor((current) => stepAnchor(scale, current, 1));
            }}
          >
            <Icon icon={ChevronRight} size="sm" />
          </Button>
        </div>
      </div>

      {/* What the address is hiding, said separately from what the window is: one is a filter
          somebody set, the other is a stretch of time somebody paged away from. */}
      {chrome.notice}

      {lostEnd === null ? null : <PartialNotice pending={lostEnd} />}

      {outside.length === 0 ? null : (
        // A window can only show a window. Saying how much is off it is the difference between a
        // timeline and a timeline that appears to have lost things - and the list further down is
        // what keeps them reachable rather than merely counted.
        <PartialNotice
          pending={
            outside.length === 1
              ? `1 item is dated outside ${axis.label}. It is listed under "Outside this window".`
              : `${String(outside.length)} items are dated outside ${axis.label}. They are listed under "Outside this window".`
          }
        />
      )}

      <Blueprint className="p-3">
        {/* The track owns the wide axis, which is this view's to own - the pane's scroller is
            y-only for exactly this reason. Inside the frame's padding rather than around it, so
            scrolled columns do not slide under the gutter beside the sticky column.

            Focusable and named, which is the standard treatment for a scrollable region: without a
            tab stop the axis can only be scrolled by tabbing through the bars inside it, so a
            keyboard user who wants to read the dates has to activate something to move. */}
        <div
          role="region"
          aria-label={`${view.name}, ${axis.label}`}
          // The rule cannot see that this element scrolls, and only its author can. Without a tab
          // stop the axis is reachable by keyboard only by tabbing through the bars inside it, so
          // somebody who wants to read the dates has to activate something to move.
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Justification: a scrollable region needs a tab stop or its content cannot be scrolled without a pointer.
          tabIndex={0}
          className={cn('overflow-x-auto', focusRing)}
        >
          <TimelineTable
            name={view.name}
            axis={axis}
            rows={rows}
            todayText={todayText}
            aside={aside}
          />
        </div>
      </Blueprint>

      {/*
        **One panel, in one place, for whichever item is being rescheduled.**

        It used to be rendered inside the row or the list entry it belonged to, which was tidier to
        read and dropped the keyboard's place on the most ordinary edit this view offers: a property
        write is optimistic, so typing a start date that now falls after the end moves the item from
        the grid to the band below *during the same render*. The row unmounted, the list entry
        mounted, and the focused field went with it - in a view whose only editing path is the
        keyboard. Here the panel is at a fixed position in the tree, so the input survives the item
        changing bucket underneath it.

        Keyed by item, so opening a different item's panel starts with its errors cleared - but not
        keyed by anything that moves when the same item is edited.
      */}
      {open === null ? null : (
        <section
          id={panelId}
          aria-label={`Reschedule ${titleOf(open.item)}`}
          className="flex flex-col gap-2 border border-divider p-3"
        >
          <div className="flex items-center justify-between gap-2">
            <Text variant="h6" as="h3">
              {`Reschedule ${titleOf(open.item)}`}
            </Text>

            <Button
              variant="ghost"
              className="py-1 text-sm"
              onClick={() => {
                setRescheduling(null);
              }}
            >
              Done
            </Button>
          </div>

          {/* Where the item sits *now*, announced when it changes. The visual move from the grid to
              a band below is silent otherwise, and somebody who has just typed a date has every
              reason to want to know their item left the axis. */}
          <div role="status">
            <Text variant="caption" tone="muted">
              {describeWhere(open, axis)}
            </Text>
          </div>

          <RescheduleFields key={open.item.id} item={open.item} aside={aside} />
        </section>
      )}

      <OffAxisList
        heading={
          reversed.length === 1
            ? '1 item has an end date before its start date'
            : `${String(reversed.length)} items have an end date before their start date`
        }
        detail="Both dates are shown as they are stored. Nothing has been changed - correct whichever one is wrong."
        placed={reversed}
        aside={aside}
      />

      <OffAxisList
        heading={`Outside this window (${String(outside.length)})`}
        detail={`These are dated, and their dates fall outside ${axis.label}.`}
        placed={outside}
        aside={aside}
      />

      <OffAxisList
        heading={`Dates that could not be read (${String(unreadable.length)})`}
        detail={`These hold a ${propertyWord(container.schema, startKey, 'start date')} that is not a date, so there is no day to draw them on. Nothing has been overwritten.`}
        placed={unreadable}
        aside={aside}
      />

      <OffAxisList
        heading={`Unscheduled (${String(undated.length)})`}
        detail={`Nothing has been lost: these have no ${propertyWord(container.schema, startKey, 'start date')} yet, so there is no day to draw them on.`}
        placed={undated}
        aside={aside}
        // Always drawn, even at zero, so "everything here is scheduled" is a statement the view
        // makes rather than an absence a reader has to infer from a missing heading.
        showWhenEmpty
        empty="Every item here has a start date."
      />

      <CreateItemControl
        label="Add an item"
        onCreate={container.create}
        className="mt-1 self-start"
      />
    </div>
  );
}

/** The grains offered, in the order they widen. */
const SCALES: readonly TimelineScale[] = ['week', 'month', 'quarter'];

/**
 * The sticky label column's width.
 *
 * Narrower below the `sm` breakpoint: twelve rem of a 375px screen is more than half of it, which
 * leaves about five day columns and a gantt nobody can read.
 */
const LABEL_COLUMN = 'sticky left-0 z-10 min-w-[8rem] sm:min-w-[12rem]';

const NO_START_PROPERTY =
  'A timeline places each bar by the date it starts on, and this view does not name a start ' +
  'property. Nothing has been lost - every item is still here, and a list or board view will ' +
  'show them.';

/**
 * Today, in the reader's own zone.
 *
 * The one place a clock is read, and the one place local time is the right question: "today" is
 * where the person is sitting, not where the server is. The result is integers immediately, so
 * nothing downstream handles an instant.
 */
function todayDay(): CalendarDay {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth(), day: now.getDate() };
}

function titleOf(item: Item): string {
  return item.title || 'Untitled';
}

function byId(itemId: string): (entry: Placed) => boolean {
  return (entry) => entry.item.id === itemId;
}

/** One item, where it sits, and the dates it really has. */
interface Placed {
  readonly item: Item;

  /**
   * The start as the reader's day - a `date` unchanged, a `timestamp` converted.
   *
   * Deliberately not "as stored": a 09:00 London start is the previous evening in Honolulu, and the
   * day this view announces has to be the reader's or the bar and its sentence would disagree.
   */
  readonly start: string | null;

  readonly end: string | null;

  /** What the start property holds, verbatim, for the case where it is not a date at all. */
  readonly startRaw: string;

  /** The same for the end property. Empty when the view names none. */
  readonly endRaw: string;

  /**
   * The start holds something, and it is not a date.
   *
   * Its own flag rather than a shade of `undated`, because the two need opposite sentences: one
   * item is waiting to be scheduled and the other has a value nobody can read.
   */
  readonly unreadable: boolean;

  readonly placement: TimelinePlacement;
}

function place(
  item: Item,
  startKey: string,
  endKey: string | null,
  zone: string,
  axis: TimelineWindow,
): Placed {
  const start = readDayValue(item, startKey, zone);
  const end = endKey === null ? null : readDayValue(item, endKey, zone);
  const startRaw = readPropertyText(item, startKey);

  return {
    item,
    start,
    end,
    startRaw,
    endRaw: endKey === null ? '' : readPropertyText(item, endKey),
    unreadable: start === null && startRaw.length > 0,
    placement: placeSpan(axis, start, end),
  };
}

/**
 * Why this timeline cannot be drawn, or null when it can.
 *
 * The same shape the calendar uses - and, in this file, the same word `view-chrome` uses for the
 * state. Core's own `unrenderable` list is consulted first because it is the authority on a view
 * whose configuration has drifted; the schema check catches the same drift locally when Core has
 * not flagged it.
 *
 * **Only the start is asked about.** A missing end property leaves a timeline of milestones, which
 * is drawable, so it is reported above the grid rather than instead of it.
 */
function describeUndrawable(
  view: View,
  schema: EffectiveSchema | null,
  views: ContainerViews | null,
): string | null {
  if (views?.unrenderable.includes(view.id) === true) {
    return `Core reports that "${view.name}" can no longer be drawn: the property its bars started from is gone or no longer fits. The items are untouched, and another view will show them.`;
  }

  if (view.dateProperty === null) {
    return NO_START_PROPERTY;
  }

  // A container with no schema - a workspace root - cannot be checked, and refusing to draw on that
  // basis would call a perfectly good timeline broken. The values are still validated as they are
  // read, so an item carrying something that is not a date lands in a band below rather than in a
  // wrong column.
  if (schema === null) {
    return null;
  }

  const definition = schema.properties.find((property) => property.key === view.dateProperty);

  if (definition === undefined) {
    return `This timeline starts its bars from "${view.dateProperty}", and that property is not in this item's schema. It was probably removed. The items are all still here; a list view will show them.`;
  }

  if (!placesOnAnAxis(definition)) {
    return `This timeline starts its bars from "${definition.label}", which is a ${propertyTypeWord(definition.type)} property rather than a date. There is no day to start from, so nothing can be drawn.`;
  }

  return null;
}

/** Both, because both name a day: a date is all-day, a timestamp is a moment that carries one. */
function placesOnAnAxis(property: PropertyDefinition): boolean {
  return isDateShaped(property.type);
}

/**
 * What the notice above the grid says about an end property that is gone, or null when none is.
 *
 * Modelled on the gallery's lost cover, and for the same reason: the property was one edit made by
 * somebody who has never seen this view, and every item is still on screen. The sentence somebody
 * needs is not "your end dates are missing" but "your items are not".
 */
function describeLostEndProperty(view: View, schema: EffectiveSchema | null): string | null {
  if (view.endDateProperty === null || schema === null) {
    return null;
  }

  const definition = schema.properties.find((property) => property.key === view.endDateProperty);
  const still = 'Every item is still here, drawn as a milestone on the day it starts.';

  if (definition === undefined) {
    return `Bars ended on "${view.endDateProperty}", which is no longer one of this item's properties. ${still}`;
  }

  // The type is named by its label rather than by the stored token: somebody who chose "Date and
  // time" from a list should not be told their property is now a "timestamp".
  return placesOnAnAxis(definition)
    ? null
    : `Bars ended on "${definition.label}", which is now a ${propertyTypeWord(definition.type)} property rather than a date. ${still}`;
}

/**
 * What a property is called mid-sentence.
 *
 * Falls back to plain English rather than to the stored key: a container whose schema request
 * degraded would otherwise put "these have no start_date yet" in front of somebody, which is
 * database jargon in a sentence meant to reassure them.
 */
function propertyWord(schema: EffectiveSchema | null, key: string, fallback: string): string {
  const definition = schema?.properties.find((property) => property.key === key);
  return definition === undefined ? fallback : definition.label.toLowerCase();
}

/** Where an item sits right now, said out loud for somebody who has just moved it. */
function describeWhere(placed: Placed, axis: TimelineWindow): string {
  switch (placed.placement.kind) {
    case 'span':
    case 'milestone':
      return `Drawn on the axis, in ${axis.label}.`;
    case 'reversed':
      return 'Listed below: its end date falls before its start date.';
    case 'outside':
      return `Listed below: dated outside ${axis.label}.`;
    default:
      return placed.unreadable
        ? 'Listed below: its start is not a date this view can read.'
        : 'Listed below as unscheduled.';
  }
}

interface ColumnHeadingProps {
  readonly column: TimelineColumn;
  readonly isToday: boolean;
}

function ColumnHeading({ column, isToday }: ColumnHeadingProps): ReactNode {
  return (
    <th
      scope="col"
      // The whole date, spelt out, so somebody moving through the row with a screen reader always
      // knows which day they are on rather than hearing a bare "17".
      aria-label={column.name}
      aria-current={isToday ? 'date' : undefined}
      className={cn(
        'min-w-(--control-md) border-b border-divider p-1 text-center',
        isToday ? 'bg-accent/18' : '',
      )}
    >
      <Text variant="kicker" as="span" tone={isToday ? 'accent' : 'muted'}>
        {column.label}
      </Text>
    </th>
  );
}

/** Everything a row or an off-axis entry needs to draw itself and to reach the reschedule panel. */
interface AsideContext {
  readonly onOpen: (itemId: string) => void;
  readonly rescheduling: string | null;
  readonly setRescheduling: (itemId: string | null) => void;

  /** The one panel every toggle in the view points at. */
  readonly panelId: string;

  readonly schema: EffectiveSchema | null;
  readonly startKey: string;
  readonly endKey: string | null;
  readonly setProperties: (
    itemId: string,
    properties: Record<string, unknown>,
  ) => Promise<string | null>;
}

interface TimelineRowProps {
  readonly placed: Placed;

  /** How many columns the axis has, for the spanning cells either side of the bar. */
  readonly columns: number;
  readonly aside: AsideContext;
  readonly virtualIndex?: number;
}

function TimelineRow({ placed, columns, aside, virtualIndex }: TimelineRowProps): ReactNode {
  const { item, placement } = placed;

  // Every branch that reaches here is a span or a milestone; the other three are lists, not rows.
  if (placement.kind !== 'span' && placement.kind !== 'milestone') {
    return null;
  }

  const first = placement.kind === 'span' ? placement.first : placement.column;
  const last = placement.kind === 'span' ? placement.last : placement.column;

  return (
    <tr
      className="align-middle"
      data-virtual-index={virtualIndex}
      aria-rowindex={virtualIndex === undefined ? undefined : virtualIndex + 2}
    >
      <th
        scope="row"
        className={cn(LABEL_COLUMN, 'border-b border-divider bg-surface p-1 text-left font-normal')}
      >
        <div className="flex items-center justify-between gap-2">
          <Text variant="bodySmall" as="span" className="truncate">
            {titleOf(item)}
          </Text>

          <RescheduleToggle item={item} aside={aside} />
        </div>
      </th>

      {/* One spanning cell rather than a run of empty ones. At the month scale a four-day bar would
          otherwise emit twenty-seven `td`s of nothing, per row - the largest allocation in this
          view and the only part of it that grows with rows times columns.

          The zero guard is load-bearing rather than defensive: `colSpan={0}` does not mean "span
          nothing" in HTML, it means "span to the end of the column group", so a bar starting in the
          first column would silently swallow the whole row. */}
      {first === 0 ? null : <td colSpan={first} className="border-b border-divider p-0" />}

      <td colSpan={last - first + 1} className="border-b border-divider p-1">
        {placement.kind === 'milestone' ? (
          <Milestone placed={placed} onOpen={aside.onOpen} />
        ) : (
          <Bar
            placed={placed}
            onOpen={aside.onOpen}
            continuesBefore={placement.continuesBefore}
            continuesAfter={placement.continuesAfter}
          />
        )}
      </td>

      {columns - last - 1 === 0 ? null : (
        <td colSpan={columns - last - 1} className="border-b border-divider p-0" />
      )}
    </tr>
  );
}

interface TimelineTableProps {
  readonly name: string;
  readonly axis: TimelineWindow;
  readonly rows: readonly Placed[];
  readonly todayText: string;
  readonly aside: AsideContext;
}

function TimelineTable(props: TimelineTableProps): ReactNode {
  const { rows } = props;
  if (rows.length <= VIRTUALIZATION_THRESHOLD) {
    return <TimelineTableContent {...props} indexes={rows.map((_entry, index) => index)} />;
  }
  return <VirtualTimelineTable {...props} />;
}

function VirtualTimelineTable(props: TimelineTableProps): ReactNode {
  const { rows } = props;
  const rootRef = useRef<HTMLTableElement>(null);
  // Stable identity keeps the virtualizer's measurement subscriptions intact between renders.
  const keys = useMemo(() => rows.map((entry) => entry.item.id), [rows]);
  const windowed = useVirtualWindow({
    keys,
    rootRef,
    estimate: ESTIMATED_TIMELINE_ROW_HEIGHT,
  });
  return (
    <TimelineTableContent
      {...props}
      rootRef={rootRef}
      indexes={windowed.indexes}
      offsets={windowed.offsets}
    />
  );
}

function TimelineTableContent(
  props: TimelineTableProps & {
    readonly indexes: readonly number[];
    readonly rootRef?: RefObject<HTMLTableElement | null>;
    readonly offsets?: readonly number[];
  },
): ReactNode {
  const { name, axis, rows, todayText, aside, indexes, rootRef, offsets } = props;
  const spacers = offsets === undefined ? [] : virtualSpacers(offsets, indexes);
  return (
    <table
      ref={rootRef}
      aria-rowcount={offsets === undefined ? undefined : rows.length + 1}
      className="w-full border-collapse"
    >
      <Text as="caption" variant="caption" className="sr-only">
        {`${name}: ${axis.label}, each item drawn across the days between its start and its end`}
      </Text>

      <thead>
        <tr>
          <th scope="col" className={cn(LABEL_COLUMN, 'bg-surface p-1 text-left')}>
            <Text variant="kicker" as="span" tone="muted">
              Item
            </Text>
          </th>
          {axis.columns.map((column) => (
            <ColumnHeading
              key={column.fromText}
              column={column}
              isToday={column.fromText <= todayText && todayText <= column.toText}
            />
          ))}
        </tr>
      </thead>

      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={axis.columns.length + 1} className="p-3">
              <Text variant="caption" tone="muted">
                {`Nothing falls inside ${axis.label}. Every item this holds is listed below.`}
              </Text>
            </td>
          </tr>
        ) : (
          indexes.flatMap((index, offset) => {
            const entry = rows[index];
            const before = spacers[offset] ?? 0;
            if (entry === undefined) {
              return [];
            }
            return [
              before > 0 ? (
                <tr key={`spacer-before-${String(index)}`} aria-hidden="true">
                  <td
                    colSpan={axis.columns.length + 1}
                    className="border-0 p-0"
                    style={{ height: before }} // design-token-exempt: the spacer height is measured runtime geometry from the shared virtual window, not a design value
                  />
                </tr>
              ) : null,
              <TimelineRow
                key={entry.item.id}
                placed={entry}
                columns={axis.columns.length}
                aside={aside}
                {...(offsets === undefined ? {} : { virtualIndex: index })}
              />,
              offset === indexes.length - 1 && (spacers[indexes.length] ?? 0) > 0 ? (
                <tr key="spacer-after" aria-hidden="true">
                  <td
                    colSpan={axis.columns.length + 1}
                    className="border-0 p-0"
                    style={{ height: spacers[indexes.length] }} // design-token-exempt: the spacer height is measured runtime geometry from the shared virtual window, not a design value
                  />
                </tr>
              ) : null,
            ];
          })
        )}
      </tbody>
    </table>
  );
}

/**
 * How a bar and a milestone answer a pointer and a press.
 *
 * `bg-accent/18` at rest is the step the calendar marks today with and this file's own column
 * heading uses, so a bar crossing the today column does not composite two different tints and
 * swallow the marker. The hover and pressed steps come from the accent ramp, which is where every
 * other interactive surface in the product takes them from.
 */
const barStates = 'bg-accent/18 hover:bg-accent/25 active:bg-accent/35 transition-colors';

interface BarProps {
  readonly placed: Placed;
  readonly onOpen: (itemId: string) => void;
  readonly continuesBefore: boolean;
  readonly continuesAfter: boolean;
}

/**
 * A span, drawn across the columns it covers.
 *
 * **The accessible name carries the dates the item really has, never the clipped ones.** A bar cut
 * off at the edge of the window is announced with its true start and its true end, because the cut
 * is a fact about the window and not about the item - and somebody told the truncated date would
 * have no way of knowing they had been.
 */
function Bar({ placed, onOpen, continuesBefore, continuesAfter }: BarProps): ReactNode {
  return (
    <button
      type="button"
      aria-label={announce(placed)}
      onClick={() => {
        onOpen(placed.item.id);
      }}
      // A tint rather than a solid accent fill. The design grammar reserves the solid accent for
      // the primary button - one of them per screen - and a row of forty saturated bars would
      // drown it.
      // `relative before:*`: h-6 is 20.4px at this density, under WCAG 2.5.8's 24px floor, and a
      // taller bar would push the rows apart. The pseudo-element extends the hit area one spacing
      // step past each edge without moving a pixel of what is drawn - the pane-divider technique.
      //
      // The extension is the row's own space, not the next row's, which is what stops one bar
      // stealing the bottom of another's target: each bar sits in a `td` with `p-1`, so between
      // two bars in successive rows there is 3.4px + a 1px border + 3.4px. Two 3.4px extensions
      // meet in the middle of that and never overlap. A row that ever loses its cell padding has
      // to shrink this to `-inset-y-0.5` in the same edit.
      className={cn(
        'relative flex h-6 w-full items-center gap-1 rounded-sm px-2 text-left',
        'before:absolute before:inset-x-0 before:-inset-y-1',
        barStates,
        focusRing,
      )}
    >
      {/* Decorative: the accessible name already carries the item's true dates, which is what says
          the bar runs past the window. A pair of announced chevrons would say it twice, worse. */}
      {continuesBefore ? (
        <Icon icon={ChevronLeft} size="sm" className="shrink-0 text-accent-text" />
      ) : null}

      <Text variant="caption" as="span" className="min-w-0 flex-1 truncate">
        {titleOf(placed.item)}
      </Text>

      {continuesAfter ? (
        <Icon icon={ChevronRight} size="sm" className="shrink-0 text-accent-text" />
      ) : null}
    </button>
  );
}

/**
 * A start with no end.
 *
 * A marker on the day, not a bar of any width. A zero-width bar would be invisible and a bar drawn
 * to today would be an end date this application made up - and one that moved every morning.
 */
function Milestone({
  placed,
  onOpen,
}: {
  readonly placed: Placed;
  readonly onOpen: (itemId: string) => void;
}): ReactNode {
  return (
    <button
      type="button"
      aria-label={announce(placed)}
      onClick={() => {
        onOpen(placed.item.id);
      }}
      // The same hit-area extension as `Bar`, for the same 20.4px height, in the same `td p-1`
      // row space - so no two of these overlap either.
      className={cn(
        'relative flex h-6 items-center gap-1 rounded-sm bg-transparent px-1 text-left',
        'before:absolute before:inset-x-0 before:-inset-y-1',
        'hover:bg-accent/18 active:bg-accent/25 transition-colors',
        focusRing,
      )}
    >
      {/* A diamond, so a milestone is never mistaken for a very short bar at a glance. Decorative:
          the control's name says "no end date" in words, which a shape cannot. */}
      <span aria-hidden="true" className="size-2 shrink-0 rotate-45 bg-accent-text" />
      <Text variant="caption" as="span" className="min-w-0 truncate">
        {titleOf(placed.item)}
      </Text>
    </button>
  );
}

/** How a stored date reads in a sentence, or the raw value when it is not a date at all. */
function spoken(date: string): string {
  const day = dayFromText(date);
  return day === null ? date : dayLabel(day);
}

/**
 * What this item's start is, mid-sentence.
 *
 * Three outcomes, not two: a date, nothing at all, and a value that is not a date. The third used
 * to be spoken as the second, which told somebody their item had no start when what it had was a
 * start nobody could read - and sent them looking for data that was sitting right there.
 */
function startPhrase(placed: Placed): string {
  if (placed.start !== null) {
    return `starts ${spoken(placed.start)}`;
  }

  return placed.startRaw.length === 0
    ? 'no start date'
    : `a start stored as "${placed.startRaw}", which is not a date`;
}

function endPhrase(placed: Placed): string {
  if (placed.end !== null) {
    return `ends ${spoken(placed.end)}`;
  }

  return placed.endRaw.length === 0
    ? 'no end date'
    : `an end stored as "${placed.endRaw}", which is not a date`;
}

/**
 * What an item's control is called: its title, then the dates it actually holds.
 *
 * One sentence for every placement, so an item announces the same facts whether it is drawn on the
 * axis, listed as reversed, listed as outside the window, or listed as unreadable.
 */
function announce(placed: Placed): string {
  const title = titleOf(placed.item);

  // Both readable: the ordinary bar, and the contradiction.
  if (placed.start !== null && placed.end !== null) {
    return placed.end < placed.start
      ? `${title}, starts ${spoken(placed.start)} and ends ${spoken(placed.end)}, which is before it starts`
      : `${title}, ${spoken(placed.start)} to ${spoken(placed.end)}`;
  }

  // An item holding nothing in either property says so once rather than twice.
  if (placed.startRaw.length === 0 && placed.endRaw.length === 0) {
    return `${title}, no start date`;
  }

  return `${title}, ${startPhrase(placed)}, ${endPhrase(placed)}`;
}

/** The dates as a line of text under a title. */
function describeDates(placed: Placed): string {
  if (placed.startRaw.length === 0 && placed.endRaw.length === 0) {
    return 'No start date and no end date.';
  }

  return `${sentence(startPhrase(placed))}. ${sentence(endPhrase(placed))}.`;
}

function sentence(phrase: string): string {
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

interface OffAxisListProps {
  readonly heading: string;
  readonly detail: string;
  readonly placed: readonly Placed[];
  readonly aside: AsideContext;
  readonly showWhenEmpty?: boolean;
  readonly empty?: string;
}

/**
 * The items the axis cannot draw, listed rather than dropped.
 *
 * One component for all four bands because they differ only in their sentence: the affordances an
 * item needs - open it, and correct its dates - are the same whether it is undated, unreadable,
 * contradictory, or merely off-screen.
 */
function OffAxisList({
  heading,
  detail,
  placed,
  aside,
  showWhenEmpty = false,
  empty,
}: OffAxisListProps): ReactNode {
  const headingId = useId();
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? placed : placed.slice(0, MAXIMUM_COLLAPSED_OFF_AXIS_ITEMS);
  const hidden = placed.length - visible.length;

  if (placed.length === 0 && !showWhenEmpty) {
    return null;
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2 border border-divider p-3">
      <Text variant="h6" as="h3" id={headingId}>
        {heading}
      </Text>

      <Text variant="caption" tone="muted">
        {placed.length === 0 ? (empty ?? detail) : detail}
      </Text>

      {placed.length === 0 ? null : (
        <ul className="flex flex-col gap-2">
          {visible.map((entry) => (
            <OffAxisEntry key={entry.item.id} placed={entry} aside={aside} />
          ))}
        </ul>
      )}

      {placed.length <= MAXIMUM_COLLAPSED_OFF_AXIS_ITEMS ? null : (
        <Button
          variant="ghost"
          className="self-start py-1 text-sm"
          aria-expanded={expanded}
          onClick={() => {
            setExpanded((current) => !current);
          }}
        >
          {expanded ? 'Show fewer' : `Show ${String(hidden)} more`}
        </Button>
      )}
    </section>
  );
}

function OffAxisEntry({
  placed,
  aside,
}: {
  readonly placed: Placed;
  readonly aside: AsideContext;
}): ReactNode {
  const { item } = placed;

  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        {/* `before:-inset-x-0.5`: the control keeps `<Button>`'s 36px height, but with `px-0` its
            width is its text's, and a one- or two-character title lands under WCAG 2.5.8's 24px
            floor - the same widening as the calendar card's title, half a step each side so it
            never reaches the reschedule toggle beside it. */}
        <Button
          variant="ghost"
          aria-label={announce(placed)}
          className="relative min-w-0 justify-start px-0 py-0.5 text-left text-sm before:absolute before:inset-y-0 before:-inset-x-0.5"
          onClick={() => {
            aside.onOpen(item.id);
          }}
        >
          <span className="truncate">{titleOf(item)}</span>
        </Button>

        <RescheduleToggle item={item} aside={aside} />
      </div>

      {/* Both dates in front of somebody, always. For a reversed pair especially: the whole reason
          this band exists is that the contradiction is worth seeing rather than being corrected
          away, and a list that named neither date would be hiding it a second time. */}
      <Text variant="caption" tone="muted">
        {describeDates(placed)}
      </Text>
    </li>
  );
}

/**
 * The way to the two writes, and in this build the only way to them.
 *
 * Every toggle in the view points at the same panel, which is the one place it is rendered. That is
 * what keeps the keyboard's place when an edit moves an item from the grid to a band below.
 */
function RescheduleToggle({
  item,
  aside,
}: {
  readonly item: Item;
  readonly aside: AsideContext;
}): ReactNode {
  const open = aside.rescheduling === item.id;

  return (
    <Button
      variant="icon"
      // Named per item, the way the calendar names its per-card control and the list names its per-
      // row cells: a screen of twelve controls all called "Reschedule" is twelve controls neither a
      // screen reader user nor a test can tell apart.
      aria-label={`Reschedule ${titleOf(item)}`}
      aria-expanded={open}
      aria-controls={aside.panelId}
      className="shrink-0"
      onClick={() => {
        aside.setRescheduling(open ? null : item.id);
      }}
    >
      <Icon icon={CalendarClock} size="sm" />
    </Button>
  );
}

/**
 * A start field and an end field, each committing its own key.
 *
 * **Two independent writes, never one.** This is the property panel's rule, and it matters more
 * here than anywhere: the server does not refuse an end that falls before its start - it cannot,
 * because two independent writes are never both valid at every instant - so an invalid end must not
 * be able to block a valid start edit. One combined write would make correcting a reversed pair
 * depend on which end you happened to fix first, which is precisely the ordering trap the server
 * declines to create.
 *
 * Each field therefore carries its own refusal, in the field that caused it - and this view draws
 * no banner, because that would be the same refusal a second time.
 */
function RescheduleFields({
  item,
  aside,
}: {
  readonly item: Item;
  readonly aside: AsideContext;
}): ReactNode {
  const [startError, setStartError] = useState<string | null>(null);
  const [endError, setEndError] = useState<string | null>(null);

  function commit(
    key: string,
    value: PropertyValue,
    report: (refusal: string | null) => void,
  ): void {
    report(null);
    void aside.setProperties(item.id, { [key]: value }).then(report);
  }

  const start = resolveDateProperty(aside.schema, aside.startKey, 'Start date');
  const end =
    aside.endKey === null ? null : resolveDateProperty(aside.schema, aside.endKey, 'End date');

  return (
    // Each field's floor holds only from `sm` up. Unconditional, 14rem was wider than the room a
    // 375px viewport leaves once the pane's gutters are taken out, so the fields forced the pane
    // wide instead of stacking; at the base width they are `w-full` rows of the wrapping flex,
    // one under the other, which is what a phone-width form is.
    <div className="flex flex-wrap items-start gap-3">
      <div className="w-full min-w-0 sm:w-auto sm:min-w-[14rem]">
        <PropertyInput
          item={item}
          property={start}
          error={startError}
          onCommit={(value) => {
            commit(start.key, value, setStartError);
          }}
        />
      </div>

      {end === null ? (
        // Not an empty box and not a disabled field: this view names no end property at all, so
        // there is nothing here to edit and saying why is the honest answer. The measure is capped
        // only from `sm` up, like the fields beside it: at the base width the container is already
        // narrower than the cap.
        <Text variant="caption" tone="muted" className="max-w-full sm:max-w-[16rem]">
          This timeline names no end date property, so every item on it is a milestone. Choose one
          under Views to give these bars a length.
        </Text>
      ) : (
        <div className="w-full min-w-0 sm:w-auto sm:min-w-[14rem]">
          <PropertyInput
            item={item}
            property={end}
            error={endError}
            onCommit={(value) => {
              commit(end.key, value, setEndError);
            }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * The declared property, or a plain date field standing in for it.
 *
 * A container with no schema - a workspace root, or an item whose schema request degraded - can
 * still hold a view naming a property, and the timeline draws in that case rather than refusing.
 * Withdrawing the reschedule control there would leave the keyboard with no way to change a date at
 * all, which is the one thing this build promises. `date` is the honest stand-in: a stored value
 * that turns out to be a timestamp is shown read-only by `PropertyInput` with the reason, rather
 * than being overwritten. The label is plain English rather than the key, so a degraded schema does
 * not put a column name in front of somebody.
 */
function resolveDateProperty(
  schema: EffectiveSchema | null,
  key: string,
  fallbackLabel: string,
): PropertyDefinition {
  return (
    schema?.properties.find((property) => property.key === key) ?? {
      key,
      label: fallbackLabel,
      type: 'date',
      options: [],
      required: false,
    }
  );
}
