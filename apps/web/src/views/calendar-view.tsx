import { Blueprint, Button, Field, Icon, Input, Text, cn } from '@nix/ui';
import { CalendarClock, ChevronLeft, ChevronRight } from 'lucide-react';
import { useId, useState, type DragEvent, type ReactNode } from 'react';

import {
  readDateValue,
  readPropertyText,
  type ContainerViews,
  type EffectiveSchema,
  type Item,
  type View,
} from './container-model';
import { CreateItemControl } from './create-item-control';
import {
  WEEKDAY_ABBREVIATIONS,
  WEEKDAY_NAMES,
  addDays,
  dayLabel,
  dayText,
  daysInMonth,
  monthEntry,
  monthLabel,
  monthPrefix,
  shiftMonth,
  weekLabel,
  weekOf,
  weekdayIndex,
  type CalendarDay,
  type CalendarMonth,
} from './calendar-dates';
import { HourGrid } from './calendar-hours';
import { readerZone } from './timestamps';
import type { ContainerData } from './use-container';
import { drawable, resolveViewChrome, undrawable } from './view-chrome';
import { useViewState } from './view-state';

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
  const [dragged, setDragged] = useState<string | null>(null);
  const [rescheduling, setRescheduling] = useState<string | null>(null);
  const unscheduledHeadingId = useId();

  const reason = describeUnrenderable(view, container.schema, container.views);
  const configured = view.dateProperty;

  const chrome = resolveViewChrome({
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

  const byDate = new Map<string, Item[]>();
  const unscheduled: Item[] = [];

  for (const item of items) {
    const value = readDateValue(item, dateProperty);

    if (value === null) {
      // Never dropped. An item with no date is an item somebody has not scheduled yet, and a
      // calendar that silently omits it is a calendar that loses half a folder without saying so.
      unscheduled.push(item);
      continue;
    }

    const existing = byDate.get(value);
    if (existing === undefined) {
      byDate.set(value, [item]);
    } else {
      existing.push(item);
    }
  }

  const prefix = monthPrefix(month);
  let elsewhere = 0;
  for (const [value, dated] of byDate) {
    if (!value.startsWith(prefix)) {
      elsewhere += dated.length;
    }
  }

  // The first configured column that is neither the title nor the date: what a card can usefully
  // say about itself in the two centimetres a day cell affords.
  const secondaryKey = view.columns.find((key) => key !== dateProperty && key !== 'title') ?? null;

  function moveTo(itemId: string, value: string | null): void {
    void container.setProperties(itemId, { [dateProperty]: value });
    setRescheduling(null);
    setDragged(null);
  }

  const card: CardContext = {
    onOpen,
    rescheduling,
    setRescheduling,
    setDragged,
    moveTo,
    secondaryKey,
    onCreate: container.create,
    dateProperty,
  };

  // One clock reading for the whole grid rather than one per cell: the answer cannot change
  // halfway through a render, and forty-two of them would be forty-two allocations for one fact.
  const todayText = today().text;

  // The view's own grain, overridable by the address the way the view itself is - a link saying
  // "look at this week" should open on a week.
  const mode = readMode(urlMode ?? view.mode);
  const zone = readerZone();

  /** One step of whatever is on screen: a month, a week, or a day. */
  function step(delta: number): void {
    if (mode === 'month') {
      setMonth(shiftMonth(month, delta));
      return;
    }

    setAnchor((current) => addDays(current, delta * (mode === 'week' ? 7 : 1)));
  }

  return (
    <div className="flex flex-col gap-4">
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
                'rounded-sm px-2 py-1 text-xs capitalize',
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

      {mode === 'month' ? (
        <Blueprint className="overflow-x-auto p-3">
          <table className="w-full table-fixed border-collapse">
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
                    className="border border-divider p-1 text-left"
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
                      <DayCell
                        key={cell.date}
                        cell={cell}
                        name={`${monthEntry(WEEKDAY_NAMES, dayIndex)} ${String(cell.day)} ${monthLabel(month)}`}
                        isToday={cell.date === todayText}
                        items={byDate.get(cell.date) ?? []}
                        dragged={dragged}
                        card={card}
                      />
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </Blueprint>
      ) : (
        <Blueprint className="flex min-h-[520px] flex-col overflow-hidden p-0">
          <HourGrid
            days={mode === 'week' ? weekOf(anchor) : [anchor]}
            items={items}
            dateProperty={dateProperty}
            zone={zone}
            today={todayText}
            onOpen={onOpen}
            onCreate={container.create}
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
            moveTo(dragged, null);
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
                <ItemCard item={item} card={card} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** One day of the grid: its number, and the `yyyy-MM-dd` text an item has to match to land on it. */
interface DayCellSpec {
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
function buildWeeks(month: CalendarMonth): readonly (readonly (DayCellSpec | null)[])[] {
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

/** What every card needs, whether it sits in a day or in the unscheduled list. */
interface CardContext {
  readonly onOpen: (itemId: string) => void;
  readonly rescheduling: string | null;
  readonly setRescheduling: (itemId: string | null) => void;
  readonly setDragged: (itemId: string | null) => void;
  readonly moveTo: (itemId: string, value: string | null) => void;
  readonly secondaryKey: string | null;
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
  readonly dragged: string | null;
  readonly card: CardContext;
}

function DayCell(props: DayCellProps): ReactNode {
  const { cell, name, isToday, items, dragged, card } = props;
  const [over, setOver] = useState(false);

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
          // anything view-local would disagree with every other view of the same folder.
          card.moveTo(dragged, cell.date);
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
            {items.map((item) => (
              <li key={item.id}>
                <ItemCard item={item} card={card} />
              </li>
            ))}
          </ul>
        )}

        {/* Created already dated to this day - the same write a drop onto it makes. Revealed on
            hover and on focus, following the tree's delete control: forty-two always-visible
            buttons would be more plus signs than calendar, but one that only exists for a pointer
            would be a way to add things that a keyboard does not have.
            `opacity-0`/`pointer-events-none`, not `invisible` - see calendar-hours.tsx's hour-slot
            and all-day controls for why `visibility: hidden` breaks the keyboard path entirely. */}
        <CreateItemControl
          compact
          label={`Add an item on ${name}`}
          properties={{ [card.dateProperty]: cell.date }}
          onCreate={card.onCreate}
          className="opacity-0 pointer-events-none mt-auto self-start focus-within:pointer-events-auto focus-within:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/day:pointer-events-auto group-hover/day:opacity-100"
        />
      </div>
    </td>
  );
}

interface ItemCardProps {
  readonly item: Item;
  readonly card: CardContext;
}

function ItemCard(props: ItemCardProps): ReactNode {
  const { item } = props;
  const { onOpen, rescheduling, setRescheduling, setDragged, moveTo, secondaryKey } = props.card;

  if (rescheduling === item.id) {
    return (
      <RescheduleForm
        item={item}
        onCancel={() => {
          setRescheduling(null);
        }}
        onMove={(value) => {
          moveTo(item.id, value);
        }}
      />
    );
  }

  const secondary = secondaryKey === null ? '' : readPropertyText(item, secondaryKey);

  return (
    <div
      draggable
      onDragStart={(event: DragEvent<HTMLDivElement>) => {
        setDragged(item.id);
        event.dataTransfer.effectAllowed = 'move';
        // Set although nothing reads it: without data attached, Firefox refuses to start the drag.
        event.dataTransfer.setData('text/plain', item.id);
      }}
      onDragEnd={() => {
        setDragged(null);
      }}
      className="flex items-start gap-1 border border-divider bg-surface px-1"
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <Button
          variant="ghost"
          className="min-w-0 justify-start px-0 py-0.5 text-left text-sm"
          onClick={() => {
            onOpen(item.id);
          }}
        >
          <span className="truncate">{item.title || 'Untitled'}</span>
        </Button>

        {secondary === '' ? null : (
          <Text variant="caption" as="span" tone="muted" className="truncate">
            {secondary}
          </Text>
        )}
      </div>

      <Button
        variant="ghost"
        aria-label={`Reschedule ${item.title || 'Untitled'}`}
        className="px-0 py-0.5"
        onClick={() => {
          setRescheduling(item.id);
        }}
      >
        <Icon icon={CalendarClock} size="sm" />
      </Button>
    </div>
  );
}

interface RescheduleFormProps {
  readonly item: Item;
  readonly onCancel: () => void;
  readonly onMove: (value: string | null) => void;
}

/**
 * The keyboard road to the same write a drag performs.
 *
 * The draft starts empty rather than pre-filled with the item's current date. Copying the stored
 * value into local state would be mirroring server data by hand for no gain: the date the item
 * already has is the cell the card is sitting in, which the reader can see, and a field asking for
 * a *new* date should not have to be emptied before it can be answered.
 *
 * What the form must not do is guess. A draft that is not a `yyyy-MM-dd` date is refused here, in
 * the field that can say so, rather than written and refused by Core.
 */
function RescheduleForm(props: RescheduleFormProps): ReactNode {
  const { item, onCancel, onMove } = props;
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  function submit(): void {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft)) {
      setError('Enter a date as year, month and day.');
      return;
    }

    onMove(draft);
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="flex flex-col gap-1 border border-divider p-1"
    >
      <Field label={`New date for ${item.title || 'Untitled'}`} error={error}>
        {(control) => (
          <Input
            {...control}
            type="date"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
          />
        )}
      </Field>

      <div className="flex flex-wrap items-center gap-1">
        <Button type="submit" className="py-1 text-sm">
          Move
        </Button>

        <Button
          variant="secondary"
          className="py-1 text-sm"
          onClick={() => {
            // Parity with dropping a card into the unscheduled list. A gesture the mouse has and
            // the keyboard does not is a gesture half the people here cannot perform.
            onMove(null);
          }}
        >
          Remove date
        </Button>

        <Button variant="ghost" className="py-1 text-sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
