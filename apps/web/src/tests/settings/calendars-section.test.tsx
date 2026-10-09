import type { CalendarConnection, CalendarLink } from '@nix/api-client';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CalendarsSection } from '../../settings/calendars-section';
import { useCalendarSync } from '../../settings/use-calendar-sync';
import { renderAt } from '../render-with-router';

vi.mock('../../settings/use-calendar-sync');

const CONNECTION: CalendarConnection = {
  id: 'account',
  provider: 'google',
  accountEmail: 'reader@example.test',
  status: 'active',
  scopes: [],
  createdAt: '2026-10-09T09:00:00Z',
  lastError: null,
};
const LINK: CalendarLink = {
  id: 'calendar',
  connectionId: CONNECTION.id,
  provider: 'google',
  workspaceId: 'workspace',
  containerItemId: 'item',
  externalCalendarId: 'external',
  name: 'Writing time',
  direction: 'import_only',
  windowPastDays: 30,
  windowFutureDays: 90,
  status: 'active',
  lastSyncedAt: null,
  lastError: null,
  revision: 1,
};
const success = () => Promise.resolve({ refusal: null });
const update = vi.fn(success);
const sync = vi.fn(success);

const calendar = {
  status: 'ready',
  providers: [],
  connections: [CONNECTION],
  links: [LINK],
  othersLinks: [],
  error: null,
  reload: () => Promise.resolve(),
  connect: success,
  disconnect: success,
  calendarsOf: () => Promise.resolve({ calendars: [], refusal: null }),
  link: success,
  update,
  unlink: success,
  unlinkOthers: success,
  sync,
  logOf: () => Promise.resolve({ entries: [], refusal: null }),
} satisfies ReturnType<typeof useCalendarSync>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useCalendarSync).mockReturnValue(calendar);
});

describe('calendar settings menus', () => {
  it('pauses the named calendar from its compact action menu', async () => {
    renderAt(<CalendarsSection />);
    await userEvent.click(screen.getByRole('button', { name: 'Actions for Writing time' }));
    const menu = screen.getByRole('menu', { name: 'Actions for Writing time' });
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Pause syncing' }));
    expect(update).toHaveBeenCalledWith(LINK, { status: 'paused' });
  });

  it('offers the same sync action from a calendar row context menu', async () => {
    renderAt(<CalendarsSection />);
    const row = screen.getByRole('row', { name: /Writing time/ });
    fireEvent.contextMenu(row);
    const menu = screen.getByRole('menu', { name: 'Actions for Writing time' });
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Sync now' }));
    expect(sync).toHaveBeenCalledWith(LINK.id);
  });

  it('offers resume and omits sync-now for a paused calendar', async () => {
    const paused = { ...LINK, status: 'paused' };
    vi.mocked(useCalendarSync).mockReturnValue({ ...calendar, links: [paused] });
    renderAt(<CalendarsSection />);
    await userEvent.click(screen.getByRole('button', { name: 'Actions for Writing time' }));
    const menu = screen.getByRole('menu', { name: 'Actions for Writing time' });
    expect(within(menu).queryByRole('menuitem', { name: 'Sync now' })).not.toBeInTheDocument();
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Resume syncing' }));
    expect(update).toHaveBeenCalledWith(paused, { status: 'active' });
  });
});
