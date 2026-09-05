import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it } from 'vitest';
import { App } from '../../app';
import { item, stubCoreApi } from '../api-stub';
import { renderAt, signedIn } from '../render-with-router';
import { stubViewport } from '../stub-viewport';

beforeEach(() => {
  signedIn();
  stubViewport(true);
});

it('opens a child over its parent and closes back to the same view', async () => {
  const root = item({
    id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
    title: 'Project',
    hasChildren: true,
  });
  const child = item({
    id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
    title: 'Plan',
    parentId: root.id,
  });
  stubCoreApi({ items: [root, child] });
  const user = userEvent.setup();
  renderAt(<App />, `/?item=${root.id}`);
  await screen.findByRole('textbox', { name: 'Note title' });
  await user.click(screen.getByRole('button', { name: 'Children' }));
  await user.click(
    await within(await screen.findByRole('region', { name: 'Container' })).findByRole('button', {
      name: 'Plan',
    }),
  );
  const dialog = await screen.findByRole('dialog', { name: 'Plan' });
  expect(within(dialog).getByRole('textbox', { name: 'Note title' })).toHaveValue('Plan');
  expect(within(dialog).getByRole('button', { name: 'Open as page' })).toBeInTheDocument();
  expect(
    within(screen.getByRole('tree', { name: 'Items' })).queryByRole('button', { name: 'Plan' }),
  ).not.toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'Bookmark Plan' }));
  expect(
    await within(screen.getByRole('region', { name: 'Pinned items' })).findByRole('button', {
      name: 'Plan',
    }),
  ).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'Close item' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Note title' })).toHaveValue('Project');
  expect(
    within(screen.getByRole('region', { name: 'Container' })).getByRole('button', { name: 'Plan' }),
  ).toBeInTheDocument();
});
