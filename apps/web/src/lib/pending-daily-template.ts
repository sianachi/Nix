/**
 * A daily note's template, waiting to be written into the note it is for.
 *
 * Opening a day creates the note on the server, but the body is a collaborative document the
 * editor owns: writing the template from outside it would race the document's first sync and
 * either duplicate or clobber what arrives. So the request waits here, the note is opened, and its
 * editor inserts the template once it holds the server's copy and finds it empty.
 *
 * Held in memory and for one note at a time. It is an unfinished gesture, not a draft: a reload
 * dropping it is correct (the note is then simply empty), and a second offer replaces the first.
 */
export interface PendingDailyTemplate {
  /** The newly created note whose body should receive the template. */
  readonly itemId: string;

  /** The workspace's template, as Markdown. */
  readonly markdown: string;
}

let pending: PendingDailyTemplate | null = null;
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) listener();
}

export function offerDailyTemplate(template: PendingDailyTemplate): void {
  pending = template;
  changed();
}

export function clearPendingDailyTemplate(): void {
  if (pending !== null) {
    pending = null;
    changed();
  }
}

/** The pending template, as `useSyncExternalStore` wants to read it. */
export function pendingDailyTemplate(): PendingDailyTemplate | null {
  return pending;
}

export function onPendingDailyTemplateChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
