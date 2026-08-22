import type { CalendarEntry } from '@nix/api-client';
import { Blueprint, Button, Segmented, Text, focusRing } from '@nix/ui';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';

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
import type { CalendarGrain } from './calendar-window';
import {
  bucketByDay,
  containersById,
  noteOptions,
  COLLATED_DATE_KEY,
  toGridItems,
} from './collated-entries';
import { CreateEntryButton } from './create-entry-button';
import { valueForDay, valueForHour } from './reschedule';

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
            <td
              key={cell.date}
              aria-label={name}
              aria-current={isToday ? 'date' : undefined}
              onDragOver={(event) => {
                // Without this the browser refuses the drop outright, so it runs whether or not this
                // calendar started the drag; the highlight below is what is conditional.
                event.preventDefault();
                setOver(cell.date);
              }}
              onDragLeave={() => {
                setOver((current) => (current === cell.date ? null : current));
              }}
              onDrop={(event) => {
                event.preventDefault();
                setOver(null);
                dropOn(cell.date);
              }}
              className={`h-24 border border-divider align-top ${
                over === cell.date && dragged !== null
                  ? 'outline-2 -outline-offset-2 outline-accent'
                  : ''
              }`}
            >
              <div className="flex h-full flex-col gap-0.5 p-1">
                <Text variant="caption" as="span" tone={isToday ? 'accent' : 'muted'}>
                  {String(cell.day)}
                </Text>

                {(byDay.get(cell.date) ?? []).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    draggable
                    onDragStart={() => {
                      setDragged(item.id);
                    }}
                    onDragEnd={() => {
                      setDragged(null);
                    }}
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
    </div>
  );
}
