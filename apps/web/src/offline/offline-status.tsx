import { Button, Text } from '@nix/ui';
import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useSessionStore } from '../auth/session-store';

import { useOfflinePreference } from './offline-preference';
import { useGeneralPreferences } from '../settings/preferences/general-preferences';
import { getOfflineSnapshot, subscribeOfflineNotes } from './offline-store';
import { requestOfflineSync } from './offline-runtime';
import { useNetworkOnline } from './use-network-online';

export function OfflineStatus({ showOpen = true }: { readonly showOpen?: boolean }): ReactNode {
  const [collapsed, setCollapsed] = useState(false);
  const snapshot = useSyncExternalStore(subscribeOfflineNotes, getOfflineSnapshot);
  const online = useNetworkOnline();
  const subject = useSessionStore((state) => state.profile?.subject);
  const authenticated = useSessionStore((state) => state.status === 'authenticated');
  const accountMatches = snapshot.account !== null && snapshot.account.subject === subject;
  const storageUnavailable =
    authenticated && snapshot.account === null && snapshot.status === 'error';
  const enabled = useOfflinePreference((state) => state.enabled);
  const footerVisible = useGeneralPreferences((state) => state.footerVisible);
  // Off means no footer at all, spacing included; what is saved stays until it is cleared.
  if (!enabled || !footerVisible) return null;
  if (!accountMatches && !storageUnavailable) return null;

  const busy = snapshot.status === 'downloading' || snapshot.status === 'syncing';
  const available = snapshot.notes.filter((note) => note.bodyAvailable).length;
  const message = !accountMatches
    ? 'Offline notes are unavailable on this device.'
    : snapshot.status === 'downloading'
      ? `Downloading notes: ${String(snapshot.completed)} of ${String(snapshot.total)}.`
      : snapshot.status === 'syncing'
        ? 'Syncing notes with Nix…'
        : snapshot.pending > 0
          ? `${String(snapshot.pending)} pending change${snapshot.pending === 1 ? '' : 's'} saved on this device.`
          : snapshot.status === 'ready'
            ? 'All unlocked notes are available offline.'
            : snapshot.status === 'loading'
              ? 'Loading notes saved on this device…'
              : `${String(available)} note${available === 1 ? '' : 's'} available on this device.`;

  return (
    <aside
      aria-label="Offline notes status"
      className="flex min-w-0 shrink-0 flex-wrap items-center justify-between gap-2 border-t border-divider bg-background px-3 py-1"
    >
      {!collapsed ? (
        <Text as="p" variant="caption" role="status" className="min-w-0 break-words">
          {message}
        </Text>
      ) : null}
      <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
        {!collapsed && showOpen && accountMatches ? (
          <Link to="/offline" className="text-sm underline underline-offset-2">
            Notes on this device
          </Link>
        ) : null}
        {!collapsed && online && accountMatches ? (
          <Button variant="ghost" disabled={busy} onClick={requestOfflineSync}>
            {busy ? 'Syncing…' : 'Sync now'}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          aria-label={collapsed ? 'Show offline sync status' : 'Collapse offline sync status'}
          aria-expanded={!collapsed}
          onClick={() => {
            setCollapsed(!collapsed);
          }}
        >
          {collapsed ? 'Device sync' : 'Collapse'}
        </Button>
      </div>
      {snapshot.error ? (
        <Text as="p" variant="caption" role="alert" className="min-w-0 w-full break-words">
          {snapshot.error}
        </Text>
      ) : null}
    </aside>
  );
}
