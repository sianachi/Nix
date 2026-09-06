import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { stubCoreApi } from '../api-stub';
import { renderAt, signedIn } from '../render-with-router';
import { App } from '../../app';

/**
 * How the settings screen is reached: by address, from the persistent rail, and through the
 * profile menu. The rail makes workspace administration findable; the account menu keeps the
 * personal-token path available where somebody already expects it.
 */

beforeEach(() => {
  signedIn();
  stubCoreApi();
});

describe('reaching the settings screen', () => {
  it('groups settings into named tabs at its own address', async () => {
    renderAt(<App />, '/settings');

    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    expect(screen.getByRole('tablist', { name: 'Settings sections' })).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Workspace' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { level: 2, name: /workspace/i })).toBeVisible();

    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Editor' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Editor' })).toBeVisible();
    expect(screen.queryByRole('heading', { level: 2, name: 'Access tokens' })).not.toBeInTheDocument();
  });

  it('is reachable from the profile menu as a real link', async () => {
    const user = userEvent.setup();
    renderAt(<App />, '/');

    // The menu button is named by the profile it shows once /me has answered.
    await user.click(await screen.findByRole('button', { name: /test person/i }));
    await user.click(screen.getByRole('menuitem', { name: /settings/i }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  });

  it('is reachable from the left rail and becomes its current destination', async () => {
    const user = userEvent.setup();
    renderAt(<App />, '/');

    const rail = await screen.findByRole('navigation', { name: /destinations/i });
    await user.click(within(rail).getByRole('link', { name: 'Settings' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    expect(within(rail).getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});
