import { Button, Text } from '@nix/ui';
import { useSyncExternalStore, type ReactNode } from 'react';
import { useSessionStore } from '../auth/session-store';

import { useOfflinePreference } from './offline-preference';
import { useGeneralPreferences } from '../settings/preferences/general-preferences';
import { getOfflineSnapshot, subscribeOfflineNotes } from './offline-store';
import { requestOfflineSync } from './offline-runtime';
import { useNetworkOnline } from './use-network-online';

/** What notes on this device are doing, shared by the status row and the profile menu. `available`
 * is whether there is anything to show; it ignores the footer preference, which hides the row, not
 * the capability. */
export function useOfflineSyncState(): {
  readonly available: boolean;
  readonly accountMatches: boolean;
  readonly online: boolean;
  readonly busy: boolean;
  readonly downloading: boolean;
  readonly pending: number;
  readonly message: string;
  readonly error: string | null;
} {
  const snapshot = useSyncExternalStore(subscribeOfflineNotes, getOfflineSnapshot);
  const online = useNetworkOnline();
  const subject = useSessionStore((state) => state.profile?.subject);
  const authenticated = useSessionStore((state) => state.status === 'authenticated');
  const accountMatches = snapshot.account !== null && snapshot.account.subject === subject;
  const storageUnavailable =
    authenticated && snapshot.account === null && snapshot.status === 'error';
  const enabled = useOfflinePreference((state) => state.enabled);
  const downloading = snapshot.status === 'downloading';
  const saved = snapshot.notes.filter((note) => note.bodyAvailable).length;
  const message = !accountMatches
    ? 'Offline notes are unavailable on this device.'
    : downloading
      ? `Downloading notes: ${String(snapshot.completed)} of ${String(snapshot.total)}.`
      : snapshot.status === 'syncing'
        ? 'Syncing notes with Nix…'
        : snapshot.pending > 0
          ? `${String(snapshot.pending)} pending change${snapshot.pending === 1 ? '' : 's'} saved on this device.`
          : snapshot.status === 'ready'
            ? 'All unlocked notes are available offline.'
            : snapshot.status === 'loading'
              ? 'Loading notes saved on this device…'
              : `${String(saved)} note${saved === 1 ? '' : 's'} available on this device.`;
  return {
    available: enabled && (accountMatches || storageUnavailable),
    accountMatches,
    online,
    busy: downloading || snapshot.status === 'syncing',
    downloading,
    pending: snapshot.pending,
    message,
    error: snapshot.error ?? null,
  };
}

/** The footer for notes on this device. Routine sync stays out of the layout: the row shows only
 * for state the owner can act on (an error, an unavailable store, a first download) or when
 * `detailed`; otherwise a screen-reader-only aside keeps the polite status line, silent for
 * routine syncing. The sync line and "Notes on this device" live in the profile menu. */
export function OfflineStatus({ detailed = false }: { readonly detailed?: boolean }): ReactNode {
  const sync = useOfflineSyncState();
  const footerVisible = useGeneralPreferences((state) => state.footerVisible);
  // Off means no footer at all, spacing included; what is saved stays until it is cleared.
  if (!sync.available || !footerVisible) return null;

  const rowVisible = detailed || !sync.accountMatches || sync.error !== null || sync.downloading;
  const quiet = sync.downloading
    ? 'Downloading notes for this device.'
    : sync.pending > 0
      ? sync.message
      : '';
  return (
    <aside
      aria-label="Offline notes status"
      className={
        rowVisible
          ? 'flex min-h-(--control-lg) min-w-0 shrink-0 flex-wrap items-center justify-between gap-x-2 border-t border-divider bg-background px-3'
          : 'sr-only'
      }
    >
      <Text as="p" variant="caption" role="status" className="min-w-0 break-words">
        {rowVisible ? sync.message : quiet}
      </Text>
      {rowVisible && (detailed || sync.error !== null) && sync.online && sync.accountMatches ? (
        <Button variant="ghost" disabled={sync.busy} onClick={requestOfflineSync}>
          {sync.busy ? 'Syncing…' : 'Sync now'}
        </Button>
      ) : null}
      {sync.error ? (
        <Text as="p" variant="caption" role="alert" className="min-w-0 w-full break-words">
          {sync.error}
        </Text>
      ) : null}
    </aside>
  );
}
