import type { CalendarEntry } from '@nix/api-client';
import { Blueprint, Button, Icon, Segmented, Text, focusRing } from '@nix/ui';
import { CalendarClock, ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';

import { HourGrid } from '../views/calendar/calendar-hours';
import { MonthGrid, type DayCellSpec } from '../views/calendar/month-grid';
import { RescheduleDialog } from '../views/calendar/reschedule-dialog';
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
import type { Item } from '../views/core/container-model';
import { readerZone } from '../views/core/timestamps';
import type { CalendarGrain } from './calendar-window';
import {
  bucketByDay,
  containersById,
  noteOptions,
  COLLATED_DATE_KEY,
  toGridItem,
  toGridItems,
} from './collated-entries';
import { CreateEntryButton } from './create-entry-button';
import { valueForDay, valueForHour } from './reschedule';

/** How many entries a month cell shows before it collapses the rest, matching `DayCell`'s own. */
const MAXIMUM_COLLAPSED_DAY_ITEMS = 6;

/**
 * Every calendar in the workspace, drawn as one.
 *
 * **The same grids the container calendar uses.** A month is `MonthGrid`, a week and a day are
 * `HourGrid`, so a reader who learns one calendar has learnt both and a change to either lands in
 * both places at once. What differs is what a day cell says: an entry here came from somewhere, and
 * saying which container is the whole point of collating.
 *
 * **Rescheduling was always answerable; creating now is too, the same way.** The container calendar
 * can create and reschedule because it knows which property it places by. This one used to say
 * creating had no answer, because entries arrive placed by whatever their own container names. Goal
 * 3.10 answers it: `onCreate` asks which container first, then resolves *that* container's own date
 * property from its own view configuration - never a guess from whichever entries are on screen,
 * which is what would make the destination depend on the month being looked at. `onCreate` stays
 * optional, matching the grids' own `onCreate`/`onMove`: a caller that has not wired it gets a
 * calendar with no way to create, not a control that appeared and did nothing.
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

  /**
   * Writes an entry's own date property.
   *
   * Answerable because the entry carries the key its own container placed it by.
   */
  readonly onReschedule: (entry: CalendarEntry, value: string) => void;

  /**
   * Makes a new item in a chosen container, dated on that container's own calendar property.
   *
   * Optional, matching the grids' own `onCreate` - absent means this caller offers no way to
   * create, rather than a button that would have nothing to do. Wired to
   * `useWorkspaceCalendar`'s `create`, which is what actually resolves the container's property and
   * writes it; this view only asks which container and which day.
   */
  readonly onCreate?:
    ((containerId: string, title: string, day: string) => Promise<string | null>) | undefined;
}

const GRAINS = [
  { value: 'month', label: 'Month' },
  { value: 'week', label: 'Week' },
  { value: 'day', label: 'Day' },
] as const satisfies readonly { value: CalendarGrain; label: string }[];

export function CollatedCalendar(props: CollatedCalendarProps): ReactNode {
  const { entries, grain, onGrain, anchor, onAnchor, today, onOpen, onReschedule, onCreate } =
    props;

  // Keyed on the payload, so stepping the grain does not rebucket entries that have not changed.
  const byDay = useMemo(() => bucketByDay(entries), [entries]);
  const items = useMemo(() => toGridItems(entries), [entries]);
  const containers = useMemo(() => containersById(entries), [entries]);

  // The containers a new entry may land in - the same notes the filter above offers, since every
  // one of them is already known to place by a real property (an entry could not exist otherwise).
  // Not memoised: it is a map and a sort over what is already in hand, not a cost worth guarding.
  const destinations = noteOptions(entries);

  // One clock reading for the whole grid rather than one per cell: the answer cannot change halfway
  // through a render, and forty-two of them would be forty-two allocations for one fact.
  const todayText = dayText(today);
  const zone = readerZone();

  // Which entry is in the air. Held by id rather than by value, so a refetch mid-drag cannot leave
  // this holding a copy of a row the server has since changed.
  const [dragged, setDragged] = useState<string | null>(null);

  // Which day the pointer is over, so exactly one cell can show it will take the drop. A boolean
  // per cell would mean forty-two pieces of state for one fact.
  const [over, setOver] = useState<string | null>(null);
  const draggedEntry = entries.find((entry) => entry.itemId === dragged) ?? null;

  const dropOn = (day: string): void => {
    if (draggedEntry === null) {
      return;
    }

    const value = valueForDay(draggedEntry, day, zone);
    setDragged(null);

    // A drop whose value cannot be expressed is refused rather than written as something else - the
    // same condition the page counts as unplaceable.
    if (value !== null && value !== draggedEntry.value) {
      onReschedule(draggedEntry, value);
    }
  };

  // Which entry's reschedule dialog is open, or null. Tap-and-keyboard's own counterpart to
  // `dragged` above: the month cell used to answer only to a drag, which a keyboard and a touch
  // screen alike cannot perform.
  const [rescheduling, setRescheduling] = useState<string | null>(null);
  const reschedulingEntry = entries.find((entry) => entry.itemId === rescheduling) ?? null;

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

        {/* Absent entirely when the caller has not wired a way to create - see this component's own
            docblock and the grids' own optional `onCreate` for why silence is the right answer
            rather than a button with nothing to do. */}
        {onCreate !== undefined && (
          <CreateEntryButton
            destinations={destinations}
            day={dayText(anchor)}
            onCreate={onCreate}
          />
        )}
      </div>

      {grain === 'month' ? (
        <MonthGrid
          month={{ year: anchor.year, month: anchor.month }}
          todayText={todayText}
          prefix="collated-"
          renderDay={(cell, name, isToday) => (
            <CollatedDayCell
              key={cell.date}
              cell={cell}
              name={name}
              isToday={isToday}
              items={byDay.get(cell.date) ?? []}
              containers={containers}
              over={over === cell.date && dragged !== null}
              onDragOver={() => {
                setOver(cell.date);
              }}
              onDragLeave={() => {
                setOver((current) => (current === cell.date ? null : current));
              }}
              onDrop={() => {
                setOver(null);
                dropOn(cell.date);
              }}
              onOpen={onOpen}
              onDragStart={setDragged}
              onDragEnd={() => {
                setDragged(null);
              }}
              onReschedule={setRescheduling}
            />
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
            // Still no per-slot create here: `HourGrid`'s own control takes one property bag and
            // has nowhere to ask which container, and this view has no cell-sized way to add a
            // destination picker to a shared control other views also use. The toolbar's
            // `CreateEntryButton` above is where creating lives in every grain instead. Moving is
            // unaffected either way, because the entry carries its own property key.
            dragged={dragged}
            onMove={(itemId, value) => {
              const entry = entries.find((candidate) => candidate.itemId === itemId);
              setDragged(null);
              if (entry === undefined || value === null) {
                return;
              }

              // The grid hands back a slot written in its own terms; this rewrites it against the
              // entry, so an all-day item dropped on an hour stays all-day rather than becoming a
              // moment its property cannot hold.
              const day = value.slice(0, 10);
              const hour = Number(value.slice(11, 13));
              const written = Number.isNaN(hour)
                ? valueForDay(entry, day, zone)
                : valueForHour(entry, day, hour, zone);

              if (written !== null && written !== entry.value) {
                onReschedule(entry, written);
              }
            }}
          />
        </Blueprint>
      )}

      {/* Tap-and-keyboard's own road to the same write a drag onto a month cell makes. `canRemove`
          is false: this calendar has no unscheduled list for "Remove date" to be the counterpart
          of, and offering the button anyway would be a control that silently did nothing. */}
      {reschedulingEntry === null ? null : (
        <RescheduleDialog
          key={reschedulingEntry.itemId}
          item={toGridItem(reschedulingEntry)}
          dateProperty={COLLATED_DATE_KEY}
          placesByTime={reschedulingEntry.kind === 'timestamp'}
          zone={zone}
          canRemove={false}
          onCancel={() => {
            setRescheduling(null);
          }}
          onMove={(value) => {
            setRescheduling(null);
            if (value !== null && value !== reschedulingEntry.value) {
              onReschedule(reschedulingEntry, value);
            }
          }}
        />
      )}
    </div>
  );
}

interface CollatedDayCellProps {
  readonly cell: DayCellSpec;

  /** The cell's accessible name: weekday, day, month and year, spelt out. */
  readonly name: string;
  readonly isToday: boolean;
  readonly items: readonly Item[];

  /** Which container each item came from, so its control can say so. */
  readonly containers: ReadonlyMap<string, string>;

  /** Whether a drop here right now would be taken. */
  readonly over: boolean;
  readonly onDragOver: () => void;
  readonly onDragLeave: () => void;
  readonly onDrop: () => void;
  readonly onOpen: (itemId: string) => void;
  readonly onDragStart: (itemId: string) => void;
  readonly onDragEnd: () => void;
  readonly onReschedule: (itemId: string) => void;
}

/**
 * One month cell of the collated calendar.
 *
 * Its own component, rather than the inline function `MonthGrid.renderDay` used to be, for the same
 * reason `calendar-view.tsx`'s own `DayCell` is one: the "show N more" disclosure is a fact about a
 * single cell, and a flag held anywhere else would either re-render every cell in the month for one
 * of them opening or have nowhere honest to live.
 */
function CollatedDayCell(props: CollatedDayCellProps): ReactNode {
  const {
    cell,
    name,
    isToday,
    items,
    containers,
    over,
    onDragOver,
    onDragLeave,
    onDrop,
    onOpen,
    onDragStart,
    onDragEnd,
    onReschedule,
  } = props;
  const [expanded, setExpanded] = useState(false);
  const visibleItems = expanded ? items : items.slice(0, MAXIMUM_COLLAPSED_DAY_ITEMS);
  const hiddenItems = items.length - visibleItems.length;

  return (
    <td
      aria-label={name}
      aria-current={isToday ? 'date' : undefined}
      onDragOver={(event) => {
        // Without this the browser refuses the drop outright, so it runs whether or not this
        // calendar started the drag; the highlight below is what is conditional.
        event.preventDefault();
        onDragOver();
      }}
      onDragLeave={onDragLeave}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
      className={`h-24 border border-divider align-top ${
        over ? 'outline-2 -outline-offset-2 outline-accent' : ''
      }`}
    >
      <div className="flex h-full flex-col gap-0.5 p-1">
        <Text variant="caption" as="span" tone={isToday ? 'accent' : 'muted'}>
          {String(cell.day)}
        </Text>

        {visibleItems.length === 0 ? null : (
          <ul className="flex flex-col gap-0.5">
            {visibleItems.map((item) => (
              <li key={item.id} className="flex items-center gap-0.5">
                <button
                  type="button"
                  draggable
                  onDragStart={() => {
                    onDragStart(item.id);
                  }}
                  onDragEnd={onDragEnd}
                  onClick={() => {
                    onOpen(item.id);
                  }}
                  // The container's name is in the accessible name rather than on screen: a day
                  // cell is two centimetres wide, and a reader who needs to know where something
                  // came from needs it said rather than truncated.
                  aria-label={`${item.title}, in ${containers.get(item.id) ?? 'Untitled'}`}
                  className={`${focusRing} min-w-0 flex-1 truncate rounded-sm bg-accent/18 px-1.5 py-0.5 text-left text-xs hover:bg-accent/25`}
                >
                  {item.title}
                </button>

                <Button
                  variant="ghost"
                  aria-label={`Reschedule ${item.title || 'Untitled'}`}
                  aria-haspopup="dialog"
                  className="shrink-0 px-0.5 py-0.5"
                  onClick={() => {
                    onReschedule(item.id);
                  }}
                >
                  <Icon icon={CalendarClock} size="sm" />
                </Button>
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
      </div>
    </td>
  );
}
