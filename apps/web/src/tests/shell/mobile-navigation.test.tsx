import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import { MobileNavigation } from '../../shell/mobile-navigation';
it('offers reachable workspace, search, calendar and note creation controls', async () => {
  const tree = vi.fn();
  const search = vi.fn();
  const create = vi.fn();
  render(
    <MemoryRouter>
      <MobileNavigation
        workspaceId="workspace"
        treeOpen={false}
        creating={false}
        onTree={tree}
        onSearch={search}
        onCreate={create}
      />
    </MemoryRouter>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Workspace' }));
  await user.click(screen.getByRole('button', { name: 'Find' }));
  await user.click(screen.getByRole('button', { name: 'New note' }));
  expect(tree).toHaveBeenCalledOnce();
  expect(search).toHaveBeenCalledOnce();
  expect(create).toHaveBeenCalledOnce();
  expect(screen.getByRole('link', { name: 'Calendar' })).toHaveAttribute(
    'href',
    '/w/workspace/calendar',
  );
});
