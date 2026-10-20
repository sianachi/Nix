import 'fake-indexeddb/auto';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';

import { clearBodyCache, openBodyCache } from '../../editor/body-cache';
import { useOfflinePreference } from '../../offline/offline-preference';
import { useGeneralPreferences } from '../../settings/preferences/general-preferences';
import { OfflineStatus } from '../../offline/offline-status';
import * as offline from '../../offline/offline-store';
import { rememberOfflineAccount } from '../../offline/offline-store';
import { signedIn } from '../render-with-router';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => {
      values.clear();
    },
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

beforeEach(async () => {
  vi.stubGlobal('localStorage', memoryStorage());
  signedIn();
  await clearBodyCache();
  await openBodyCache('test-subject');
  await rememberOfflineAccount({
    subject: 'test-subject',
    name: 'Test Person',
    email: 'test@example.test',
  });
  useOfflinePreference.setState({ enabled: true, saved: true });
  useGeneralPreferences.setState({ footerVisible: true });
});

function renderFooter() {
  return render(
    <MemoryRouter>
      <OfflineStatus />
    </MemoryRouter>,
  );
}

function snapshot(change: Partial<offline.OfflineSnapshot>): void {
  vi.spyOn(offline, 'getOfflineSnapshot').mockReturnValue({
    account: { subject: 'test-subject', name: 'Test Person', email: 'test@example.test' },
    notes: [],
    workspaces: [],
    status: 'ready',
    completed: 0,
    total: 0,
    pending: 0,
    error: null,
    lastSyncedAt: null,
    ...change,
  });
}

it('keeps routine sync out of the layout', () => {
  snapshot({ status: 'syncing' });
  renderFooter();
  expect(screen.getByRole('complementary', { name: 'Offline notes status' })).toHaveClass(
    'sr-only',
  );
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('');
});

it('announces pending changes politely without taking a row', () => {
  snapshot({ pending: 2 });
  renderFooter();
  expect(screen.getByRole('status')).toHaveTextContent('2 pending changes saved on this device.');
  expect(screen.getByRole('complementary')).toHaveClass('sr-only');
});

it('shows a one-line row with Sync now after an error', () => {
  snapshot({ status: 'error', error: 'Sync failed.' });
  renderFooter();
  expect(screen.getByRole('complementary')).not.toHaveClass('sr-only');
  expect(screen.getByRole('alert')).toHaveTextContent('Sync failed.');
  expect(screen.getByRole('button', { name: 'Sync now' })).toBeVisible();
});

it('shows download progress while downloading', () => {
  snapshot({ status: 'downloading', completed: 3, total: 18 });
  renderFooter();
  expect(screen.getByRole('complementary')).not.toHaveClass('sr-only');
  expect(screen.getByRole('status')).toHaveTextContent('Downloading notes: 3 of 18.');
});

it('renders nothing at all, spacing included, once device sync is turned off', () => {
  useOfflinePreference.setState({ enabled: false });
  const { container } = renderFooter();
  expect(container).toBeEmptyDOMElement();
  expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
});

it('renders nothing at all when general preferences footerVisible is false', () => {
  useGeneralPreferences.setState({ footerVisible: false });
  const { container } = renderFooter();
  expect(container).toBeEmptyDOMElement();
  expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
});

it('remembers the choice only when it is off, so the default stays forward-compatible', () => {
  useOfflinePreference.getState().setEnabled(false);
  expect(localStorage.getItem('nix.offline.enabled')).toBe('off');
  useOfflinePreference.getState().setEnabled(true);
  expect(localStorage.getItem('nix.offline.enabled')).toBeNull();
});
