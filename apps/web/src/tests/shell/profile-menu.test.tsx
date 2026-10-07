import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CurrentPrincipalState } from '../../session/use-current-principal';
import { ProfileMenu } from '../../shell/profile-menu';

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';

const auth = vi.hoisted(() => ({
  accountUrl: null as string | null,
  signOut: vi.fn(() => Promise.resolve()),
}));

// The menu reads only these two seams; stubbing them keeps the test off the provider stack.
vi.mock('../../auth/auth-provider', () => ({
  useAuth: () => ({
    accountUrl: auth.accountUrl,
    signOut: auth.signOut,
    signIn: () => Promise.resolve(),
    getAccessToken: () => Promise.resolve(null),
    isConfigured: true,
  }),
}));

vi.mock('../../workspaces/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: WORKSPACE_ID }),
}));

const principal: CurrentPrincipalState = {
  status: 'ready',
  principal: {
    id: '00000000-0000-4000-8000-000000000002',
    tenantId: '00000000-0000-4000-8000-000000000003',
    displayName: 'Ada Person',
    email: 'ada@example.test',
    isTenantAdministrator: false,
  },
  error: null,
  reload: () => Promise.resolve(),
};

async function openMenu(): Promise<void> {
  render(
    <MemoryRouter>
      <ProfileMenu principal={principal} />
    </MemoryRouter>,
  );
  await userEvent.setup().click(screen.getByRole('button', { name: /Ada Person/ }));
}

beforeEach(() => {
  auth.accountUrl = null;
});

describe('ProfileMenu', () => {
  it('lets the keyboard reach and change appearance without dismissing the menu', async () => {
    const user = userEvent.setup();
    await openMenu();
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('radio', { name: 'System' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('dialog', { name: 'Account' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Light' })).toHaveFocus();
    expect(screen.getByRole('radio', { name: 'Light' })).toBeChecked();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Account' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Ada Person/ })).toHaveFocus();
  });

  it('links to the identity provider account page in a new tab when Core names one', async () => {
    auth.accountUrl = 'https://sso.example.test/ui/console/users/me?id=security';

    await openMenu();

    const link = screen.getByRole('link', { name: /Password and security/ });
    expect(link).toHaveAttribute(
      'href',
      'https://sso.example.test/ui/console/users/me?id=security',
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAccessibleName('Password and security (opens in a new tab)');
  });

  it('offers no account link when the deployment names no account page', async () => {
    await openMenu();

    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'href',
      `/w/${WORKSPACE_ID}/settings`,
    );
    expect(screen.getByRole('link', { name: 'Settings' })).not.toHaveAttribute('target');
    expect(screen.queryByRole('link', { name: /Password and security/ })).toBeNull();
  });
});
