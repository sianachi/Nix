/**
 * Every calendar in a workspace, collated into one window of dated entries.
 *
 * Three properties of the payload are worth knowing before writing a view against it, because all
 * three are guarantees rather than accidents.
 *
 * **A date is a date wherever it was set.** Which property carries an item's date is decided by the
 * container that holds it, so entries in one response may have been placed by differently named
 * properties. Each entry carries the key it was placed by and the container that decided it, which
 * is what lets a view show them together without claiming one of them was wrong.
 *
 * **Values are not normalised.** A `date` is a day and a `timestamp` is a moment in a named zone,
 * and only the reader's own zone decides which day a moment falls on. The server windows coarsely
 * by the day the value is written with; the client places precisely. An entry near a window edge
 * can therefore belong to a different day for the reader than for the window, which is correct
 * rather than a rounding error.
 *
 * **The response is bounded, and it says so twice.** `entriesTruncated` means the window holds more
 * than came back. `unplaceable` names containers that offer a calendar and could place nothing —
 * that list is never truncated, because it is the part of the answer that explains what is missing.
 * A truncated list looks short and announces itself; a truncated calendar looks like a calendar, so
 * a view that renders this must say so.
 */

import { z } from 'zod';
import type { components } from '../generated/api.js';

/** Which of the two dated property types placed an entry. */
export const calendarEntryKindSchema = z.enum(['date', 'timestamp']);

export type CalendarEntryKind = z.infer<typeof calendarEntryKindSchema>;

/** One dated item, and where its date came from. */
export const calendarEntrySchema = z.object({
  itemId: z.uuid(),

  /**
   * What the item is called, or null when it has never been named. The server does not invent a
   * name, so a view that wants one supplies its own copy.
   */
  title: z.string().nullable(),

  /** The container whose calendar view placed it. */
  containerId: z.uuid(),

  /** What that container is called, so an entry can say where it came from without a second read. */
  containerTitle: z.string().nullable(),

  /** The property key this entry was placed by. Different containers may name different ones. */
  dateProperty: z.string(),

  /**
   * The stored value, verbatim: either a plain `yyyy-MM-dd` day or an RFC 9557 moment with a
   * bracketed zone. Parsed by the reader, in the reader's zone.
   */
  value: z.string(),

  kind: calendarEntryKindSchema,
});

export type CalendarEntry = z.infer<typeof calendarEntrySchema>;

/**
 * A container that offers a calendar and could place nothing on it.
 *
 * The reason is a token rather than a sentence, because the sentence belongs where it can be
 * translated. Today the only value is `no_date_property`.
 */
export const unplaceableCalendarSchema = z.object({
  containerId: z.uuid(),
  containerTitle: z.string().nullable(),
  reason: z.string(),
});

export type UnplaceableCalendar = z.infer<typeof unplaceableCalendarSchema>;

/**
 * A ceiling the server applied, echoed back.
 *
 * `number | string` for the reason `itemSequenceSchema` is: the contract publishes integers as
 * either, and the schema accepts what the contract permits rather than what we expect to see.
 */
const calendarLimitSchema = z.union([z.int(), z.string().regex(/^-?\d+$/)]);

export const workspaceCalendarSchema = z.object({
  workspaceId: z.uuid(),

  /** The window that was asked for, echoed so a late response can be matched to its request. */
  from: z.string(),
  to: z.string(),

  entries: z.array(calendarEntrySchema),
  unplaceable: z.array(unplaceableCalendarSchema),

  entryLimit: calendarLimitSchema,

  /** True when the ceiling was reached, so this is part of the window and not all of it. */
  entriesTruncated: z.boolean(),
});

export type WorkspaceCalendar = z.infer<typeof workspaceCalendarSchema>;

/**
 * The compile-time tie to the generated contract. A field Core renames stops this package
 * compiling rather than failing at runtime in front of a user.
 */
const _workspaceCalendarContract = workspaceCalendarSchema satisfies z.ZodType<
  components['schemas']['WorkspaceCalendarResponse']
>;
void _workspaceCalendarContract;
