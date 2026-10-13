import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '../../app';
import { STUB_WORKSPACE, stubCoreApi, type StubWorkspace } from '../api-stub';
import { renderAt, signedIn } from '../render-with-router';
import {
  arrangeWorkspaces,
  assignToGroup,
  removeGroup,
  togglePin,
} from '../../workspaces/arrangement';

const SHARED: StubWorkspace = {
  ...STUB_WORKSPACE,
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Shared team space',
  kind: 'shared',
};
const GONE = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  signedIn();
});

describe('arrangeWorkspaces', () => {
  it('lays groups and pins over the visible workspaces, dropping ids the person cannot see', () => {
    const arrangement = {
      groups: [{ id: 'g1', name: 'Work', workspaceIds: [SHARED.id, GONE] }],
      pinnedWorkspaceIds: [GONE, STUB_WORKSPACE.id],
    };
    const arranged = arrangeWorkspaces([STUB_WORKSPACE, SHARED], arrangement);
    expect(arranged.pinned.map((entry) => entry.id)).toEqual([STUB_WORKSPACE.id]);
    expect(arranged.groups[0]?.workspaces.map((entry) => entry.id)).toEqual([SHARED.id]);
    expect(arranged.ungrouped.map((entry) => entry.id)).toEqual([STUB_WORKSPACE.id]);
    // Removing the group keeps the workspace; it only becomes ungrouped.
    expect(
      arrangeWorkspaces([STUB_WORKSPACE, SHARED], removeGroup(arrangement, 'g1')).ungrouped,
    ).toHaveLength(2);
    // A workspace sits in one group at most.
    const moved = assignToGroup(
      {
        ...arrangement,
        groups: [...arrangement.groups, { id: 'g2', name: 'Home', workspaceIds: [] }],
      },
      SHARED.id,
      'g2',
    );
    expect(moved.groups.map((group) => group.workspaceIds)).toEqual([[GONE], [SHARED.id]]);
    expect(togglePin(togglePin(arrangement, SHARED.id), SHARED.id).pinnedWorkspaceIds).toEqual(
      arrangement.pinnedWorkspaceIds,
    );
  });
});

describe('the workspace menu', () => {
  it('pins a workspace from the menu and shows a Pinned section that persists through the stub', async () => {
    const user = userEvent.setup();
    stubCoreApi({ workspaces: [STUB_WORKSPACE, SHARED] });
    renderAt(<App />);

    await user.click(await screen.findByRole('button', { name: 'Workspace menu' }));
    const menu = screen.getByRole('region', { name: 'Workspaces' });
    expect(within(menu).queryByRole('heading', { name: 'Pinned' })).not.toBeInTheDocument();
    await user.click(within(menu).getByRole('button', { name: `Pin ${SHARED.name}` }));
    expect(await within(menu).findByRole('heading', { name: 'Pinned' })).toBeVisible();
    const pinned = within(menu).getByRole('list', { name: 'Pinned' });
    expect(within(pinned).getByRole('link', { name: SHARED.name })).toHaveAttribute(
      'href',
      `/w/${SHARED.id}`,
    );
    // Pinned is quick access: the workspace keeps its place in its own list as well.
    expect(within(pinned).getByRole('button', { name: `Unpin ${SHARED.name}` })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(menu).getAllByRole('link', { name: SHARED.name })).toHaveLength(2);
  });

  it('lists saved groups with their workspaces and the rest under Other workspaces', async () => {
    const user = userEvent.setup();
    stubCoreApi({
      workspaces: [STUB_WORKSPACE, SHARED],
      workspaceArrangement: {
        revision: 3,
        groups: [
          {
            id: '44444444-4444-4444-8444-444444444444',
            name: 'Clients',
            workspaceIds: [SHARED.id, GONE],
          },
        ],
        pinnedWorkspaceIds: [],
      },
    });
    renderAt(<App />);

    await user.click(await screen.findByRole('button', { name: 'Workspace menu' }));
    const menu = screen.getByRole('region', { name: 'Workspaces' });
    const clients = await within(menu).findByRole('list', { name: 'Clients' });
    expect(within(clients).getByRole('link', { name: SHARED.name })).toBeVisible();
    const other = within(menu).getByRole('list', { name: 'Other workspaces' });
    expect(within(other).getByRole('link', { name: STUB_WORKSPACE.name })).toBeVisible();
    expect(within(menu).queryByText(GONE)).not.toBeInTheDocument();
  });
});

describe('workspace groups in settings', () => {
  it('creates a group, assigns a workspace to it and removes the group without losing the workspace', async () => {
    const user = userEvent.setup();
    stubCoreApi({ workspaces: [STUB_WORKSPACE, SHARED] });
    renderAt(<App />, '/settings');

    const section = await screen.findByRole('region', { name: 'Workspace groups and pins' });
    await user.type(within(section).getByRole('textbox', { name: 'New group' }), 'Clients');
    await user.click(within(section).getByRole('button', { name: 'Add group' }));
    const groups = await within(section).findByRole('list', { name: 'Workspace groups' });
    expect(within(groups).getByRole('textbox', { name: 'Group name' })).toHaveValue('Clients');

    await user.selectOptions(
      within(section).getByRole('combobox', { name: `Group for ${SHARED.name}` }),
      'Clients',
    );
    await waitFor(() => {
      expect(within(groups).getByText(SHARED.name)).toBeVisible();
    });

    await user.click(within(section).getByRole('button', { name: 'Remove group Clients' }));
    await waitFor(() => {
      expect(
        within(section).queryByRole('list', { name: 'Workspace groups' }),
      ).not.toBeInTheDocument();
    });
    // Still here, still choosable: a removed group takes nothing with it.
    expect(
      within(section).getByRole('combobox', { name: `Group for ${SHARED.name}` }),
    ).toBeDisabled();
    expect(within(section).getByText(SHARED.name)).toBeVisible();
  });
});
