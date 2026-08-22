import type { CalendarEntry } from '@nix/api-client';

import { readTimestampValue, writeTimestampValue } from '../views/core/timestamps';

/**
 * What to write when an entry is dragged somewhere else.
 *
 * **Rescheduling is answerable from the entry alone.** Each entry carries the key its own container
 * placed it by, so moving it writes that key on that item and nothing has to be guessed. Creating
 * used to have no answer here for the same reason in reverse - a brand new item carries no entry to
 * read a key from - but goal 3.10 answers it a different way: `use-workspace-calendar.ts`'s
 * `create` asks the chosen container's own view configuration directly, rather than reading
 * anything off an entry.
 *
 * Nothing here reads a clock. The target and the reader's zone are both given, so the same drag
 * produces the same value twice and it can be tested without a browser.
 */

/**
 * The value an entry should carry after being dropped on a day.
 *
 * **A moment keeps its time; a date is just a date.** Dragging a nine-o'clock standup from Tuesday
 * to Wednesday means nine o'clock on Wednesday - the reader moved it across the grid, not across
 * the clock. Writing the bare day would silently discard the time, which is data the reader never
 * asked to lose and cannot get back from the interface.
 *
 * Returns null when the entry's stored value cannot be read, which is the same condition the view
 * counts as unplaceable. A drop that cannot be expressed is refused rather than written as
 * something else.
 */
export function valueForDay(entry: CalendarEntry, day: string, zone: string): string | null {
  if (entry.kind === 'date') {
    return day;
  }

  // `readTimestampValue` reads a property off a bag, because that is what every other caller has.
  // Here the value is already in hand, so it is handed over under a key of its own.
  const at = readTimestampValue({ value: entry.value }, 'value');
  if (at === null) {
    return null;
  }

  const local = at.at.setZone(zone);
  const time = local.toFormat('HH:mm:ss');

  // Written through the same helper the container calendar writes through, so the two views produce
  // byte-identical values for the same moment rather than two spellings the server accepts and a
  // later reader has to tell apart.
  return writeTimestampValue(`${day}T${time}`, zone);
}

/**
 * The value an entry should carry after being dropped on an hour of a day.
 *
 * A drop on an hour is a statement about the time as well as the day, so for a moment this
 * overrides both.
 *
 * **An all-day entry stays all-day, and that is not this view being timid.** Whether a property
 * holds a day or a moment is decided by its container's schema, not by where somebody dropped
 * something. Writing a timestamp into a `date` property is a value the server refuses outright -
 * it parses that column as `yyyy-MM-dd` and nothing else - so the drag would appear to work and
 * then quietly fail. Moving the day and keeping it all-day is the part of the gesture that can
 * actually be honoured.
 */
export function valueForHour(
  entry: CalendarEntry,
  day: string,
  hour: number,
  zone: string,
): string | null {
  if (entry.kind === 'date') {
    return day;
  }

  return writeTimestampValue(`${day}T${String(hour).padStart(2, '0')}:00:00`, zone);
}
