/**
 * Named, memoised date/time formatters shared across the app. Each is named after what it shows
 * so a call site picks the shape it needs rather than hand-building an `Intl.DateTimeFormat`
 * options bag. `lib/` is a leaf: this file imports nothing feature-specific.
 */

const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

const fullDateFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

const shortDateFormatters = new Map<string, Intl.DateTimeFormat>();

/** `en-CA` sorts `year`/`month`/`day` into `yyyy-mm-dd`, which is what every short-date call site
 * wants; formatters are cached per timezone since that's the only thing that varies. */
function shortDateFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = shortDateFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    shortDateFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** A clock time in the reader's own locale - "9:41 AM". */
export function formatTime(date: Date): string {
  return timeFormatter.format(date);
}

/** A full calendar date in the reader's own locale - "Tuesday, September 22, 2026". */
export function formatFullDate(date: Date): string {
  return fullDateFormatter.format(date);
}

/** A medium date with a short time, in the reader's own locale - "Sep 22, 2026, 9:41 AM". */
export function formatDateTime(date: Date): string {
  return dateTimeFormatter.format(date);
}

/** A `yyyy-mm-dd` calendar date for the given IANA timezone - "2026-09-22". */
export function formatShortDate(date: Date, timeZone: string): string {
  return shortDateFormatter(timeZone).format(date);
}

/** The reader's own IANA timezone, as their runtime resolves it. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
