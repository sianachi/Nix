import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import { MobileNavigation } from '../../shell/mobile-navigation';
it('offers reachable workspace, search, calendar, inbox and note creation controls', async () => {
  const tree = vi.fn();
  const search = vi.fn();
  const create = vi.fn();
  const openInbox = vi.fn();
  render(
    <MemoryRouter>
      <MobileNavigation
        workspaceId="workspace"
        treeOpen={false}
        creating={false}
        unreadNotifications={0}
        petAttention={null}
        onTree={tree}
        onSearch={search}
        onCreate={create}
        onOpenInbox={openInbox}
      />
    </MemoryRouter>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Workspace' }));
  await user.click(screen.getByRole('button', { name: 'Find' }));
  await user.click(screen.getByRole('button', { name: 'Inbox' }));
  await user.click(screen.getByRole('button', { name: 'New note' }));
  expect(tree).toHaveBeenCalledOnce();
  expect(search).toHaveBeenCalledOnce();
  expect(openInbox).toHaveBeenCalledOnce();
  expect(create).toHaveBeenCalledOnce();
  expect(screen.getByRole('link', { name: 'Calendar' })).toHaveAttribute(
    'href',
    '/w/workspace/calendar',
  );
});

it('announces the unread count as part of the inbox control name', () => {
  render(
    <MemoryRouter>
      <MobileNavigation
        workspaceId="workspace"
        treeOpen={false}
        creating={false}
        unreadNotifications={3}
        petAttention={null}
        onTree={() => undefined}
        onSearch={() => undefined}
        onCreate={() => undefined}
        onOpenInbox={() => undefined}
      />
    </MemoryRouter>,
  );
  expect(screen.getByRole('button', { name: 'Inbox, 3 unread' })).toBeVisible();
});

it('marks the workspace control while the pet is waiting and its only way in is that drawer', () => {
  render(
    <MemoryRouter>
      <MobileNavigation
        workspaceId="workspace"
        treeOpen={false}
        creating={false}
        unreadNotifications={0}
        petAttention="needs approval"
        onTree={vi.fn()}
        onSearch={vi.fn()}
        onCreate={vi.fn()}
        onOpenInbox={vi.fn()}
      />
    </MemoryRouter>,
  );
  expect(screen.getByRole('button', { name: 'Workspace, pet needs approval' })).toBeVisible();
});
