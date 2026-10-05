/**
 * The local calendar date a daily note is for right now.
 *
 * `rolloverHour` is the hour the day changes: somebody working past midnight is still on
 * yesterday's note until then. It is subtracted from the clock before the date is read, so the
 * shift is the same wherever the zone's day boundary falls. Only "today" moves - an explicit date
 * in an address is never shifted.
 */
export function localDailyNoteDate(now = new Date(), rolloverHour = 0): string {
  const shifted = new Date(now);
  if (shifted.getHours() < rolloverHour) shifted.setDate(shifted.getDate() - 1);
  const year = String(shifted.getFullYear()).padStart(4, '0');
  const month = String(shifted.getMonth() + 1).padStart(2, '0');
  const day = String(shifted.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * The date a number of days away, worked on the year-month-day parts in UTC so that a daylight
 * saving change in the reader's zone cannot land on the wrong day. Null for an unreadable date.
 */
export function shiftDailyNoteDate(value: string, days: number): string | null {
  if (parseDailyNoteDate(value) === null) return null;
  const [year, month, day] = value.split('-').map(Number);
  const moved = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, (day ?? 0) + days));
  const y = String(moved.getUTCFullYear()).padStart(4, '0');
  const m = String(moved.getUTCMonth() + 1).padStart(2, '0');
  const d = String(moved.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function parseDailyNoteDate(value: string | undefined): string | null {
  if (value === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const candidate = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day));
  return candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() + 1 === month &&
    candidate.getUTCDate() === day
    ? value
    : null;
}

export function dailyNoteLabel(value: string): string {
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day)));
}
