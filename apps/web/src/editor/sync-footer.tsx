import type { ReactNode } from 'react';

import type { SyncState } from './collab-sync';

/**
 * The connection state, said in the terms a writer actually needs - shared by every body
 * editor, because the transport underneath them is the same one.
 *
 * Six states, none of them a spinner standing in for the others. "Live" means edits are
 * streaming to everyone now; "pending" means edits exist here that the server does not
 * have yet; "read-only" and "at capacity" are the server's own words, relayed rather than
 * hidden - and every disconnected state says your work is safe locally, because with a
 * CRDT it genuinely is.
 */
export function SyncFooter({ state }: { readonly state: SyncState }): ReactNode {
  const message =
    state === 'live'
      ? 'Live. Edits reach other people as you type.'
      : state === 'pending'
        ? 'Saving locally. Your edits will sync when the connection returns.'
        : state === 'connecting'
          ? 'Connecting…'
          : state === 'readonly'
            ? 'Read-only. Your access to this document changed, so edits are not accepted.'
            : state === 'degraded'
              ? 'The server cannot take this document right now. Your edits are kept here; retrying, and reloading may help.'
              : 'Offline. Your edits are kept here and will be sent when the connection returns.';

  return (
    <footer
      // Polite rather than assertive: the state changes on a timer, and an assertive region would
      // interrupt a screen-reader user mid-sentence every time it did.
      aria-live="polite"
      className="border-t border-divider px-8 py-2 text-xs text-muted"
    >
      {message}
    </footer>
  );
}
