import 'fake-indexeddb/auto';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';

import { clearBodyCache, openBodyCache } from '../../editor/body-cache';
import { useOfflinePreference } from '../../offline/offline-preference';
import { useGeneralPreferences } from '../../settings/preferences/general-preferences';
import { OfflineStatus } from '../../offline/offline-status';
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

it('shows the sync footer while notes are kept on this device', () => {
  renderFooter();
  expect(screen.getByRole('complementary', { name: 'Offline notes status' })).toBeVisible();
  expect(screen.getByRole('link', { name: 'Notes on this device' })).toBeVisible();
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
