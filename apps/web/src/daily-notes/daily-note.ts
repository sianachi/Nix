/** The one root item that groups journal entries without inventing another kind of item. */
export const DAILY_NOTES_ROOT_TITLE = 'Daily notes';

/** Obsidian-compatible default daily-note title, expressed in the browser's local date. */
export function dailyNoteTitle(now = new Date()): string {
  const year = String(now.getFullYear()).padStart(4, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Human-readable companion for the short-lived opening state. */
export function dailyNoteLabel(now = new Date()): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(now);
}
