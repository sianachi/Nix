import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { App } from '../../app';
import { item, stubCoreApi } from '../api-stub';
import { renderAt, signedIn } from '../render-with-router';
import { aView } from '../view-fixture';
import { stubViewport } from '../stub-viewport';

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
beforeEach(() => {
  signedIn();
  stubViewport(false);
});
it('opens list items as pages and Back restores the parent list view', async () => {
  stubCoreApi({
    items: [root, child],
    views: { [root.id]: { views: [aView({ name: 'List' })], default: 'document' } },
  });
  renderAt(<App />, `/?item=${root.id}`);
  await screen.findByRole('textbox', { name: 'Note title' });
  await userEvent.click(await screen.findByRole('button', { name: 'List' }));
  await userEvent.click(
    await within(await screen.findByRole('region', { name: 'Container' })).findByRole('button', {
      name: 'Plan',
    }),
  );
  expect(await screen.findByRole('textbox', { name: 'Note title' })).toHaveValue('Plan');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Back' }));
  expect(
    await within(await screen.findByRole('region', { name: 'Container' })).findByRole('button', {
      name: 'Plan',
    }),
  ).toBeInTheDocument();
});
it('keeps a dismissed capture title and creates in the selected destination', async () => {
  stubCoreApi({
    items: [root, child],
    views: { [root.id]: { views: [aView({ name: 'List' })], default: 'document' } },
  });
  renderAt(<App />, `/?item=${root.id}`);
  await screen.findByRole('textbox', { name: 'Note title' });
  await userEvent.click(screen.getByRole('button', { name: 'New note' }));
  let dialog = screen.getByRole('dialog', { name: 'New note' });
  await userEvent.type(
    within(dialog).getByRole('textbox', { name: 'Note title' }),
    'Captured idea',
  );
  await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  await userEvent.click(screen.getByRole('button', { name: 'New note' }));
  dialog = screen.getByRole('dialog', { name: 'New note' });
  expect(within(dialog).getByRole('textbox', { name: 'Note title' })).toHaveValue('Captured idea');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Create in: Workspace' }));
  await userEvent.click(within(dialog).getByRole('button', { name: 'Project' }));
  await userEvent.click(within(dialog).getByRole('button', { name: 'Create note' }));
  await waitFor(() => {
    expect(screen.getByRole('textbox', { name: 'Note title' })).toHaveValue('Captured idea');
  });
  await userEvent.click(screen.getByRole('button', { name: 'Project' }));
  await userEvent.click(await screen.findByRole('button', { name: 'List' }));
  expect(
    await within(await screen.findByRole('region', { name: 'Container' })).findByRole('button', {
      name: 'Captured idea',
    }),
  ).toBeInTheDocument();
});
it('provides one-level browsing and access to the full workspace tree', async () => {
  stubCoreApi({
    items: [root, child],
    views: { [root.id]: { views: [aView({ name: 'List' })], default: 'document' } },
  });
  renderAt(<App />, `/?item=${root.id}`);
  await screen.findByRole('textbox', { name: 'Note title' });
  await userEvent.click(screen.getByRole('button', { name: 'Workspace' }));
  await userEvent.click(screen.getByRole('button', { name: 'Browse children of Project' }));
  expect(await screen.findByRole('button', { name: 'Plan' })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Tree and actions' }));
  expect(screen.getByRole('tree', { name: 'Items' })).toBeInTheDocument();
});

it('retains the capture title and reports a refused create without navigating', async () => {
  stubCoreApi({ items: [root], createRefusal: 'You cannot create here.' });
  renderAt(<App />, `/?item=${root.id}`);
  await screen.findByRole('textbox', { name: 'Note title' });
  await userEvent.click(screen.getByRole('button', { name: 'New note' }));
  const dialog = screen.getByRole('dialog', { name: 'New note' });
  await userEvent.type(
    within(dialog).getByRole('textbox', { name: 'Note title' }),
    'Keep this idea',
  );
  await userEvent.click(within(dialog).getByRole('button', { name: 'Create note' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('You cannot create here.');
  expect(within(dialog).getByRole('textbox', { name: 'Note title' })).toHaveValue('Keep this idea');
});

it('moves an item through a destination sheet without dragging', async () => {
  const movable = { ...child };
  stubCoreApi({ items: [root, movable] });
  const fallback = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith(`/api/v1/items/${child.id}/move`) && init?.method === 'POST') {
      if (typeof init.body !== 'string') throw new Error('Expected a JSON move request.');
      expect(JSON.parse(init.body)).toEqual({ parentId: null, afterId: null });
      movable.parentId = null;
      return new Response(JSON.stringify(movable), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return fallback(input, init);
  });
  renderAt(<App />, `/?item=${child.id}`);
  await screen.findByRole('textbox', { name: 'Note title' });
  await userEvent.click(screen.getByRole('button', { name: 'Item actions' }));
  await userEvent.click(
    within(screen.getByRole('dialog', { name: 'Item actions' })).getByRole('button', {
      name: 'Move item',
    }),
  );
  const move = screen.getByRole('dialog', { name: 'Move item: choose a place' });
  await userEvent.click(within(move).getByRole('button', { name: 'Up one level' }));
  await userEvent.click(within(move).getByRole('button', { name: 'Choose position' }));
  await userEvent.click(
    within(screen.getByRole('dialog', { name: 'Move item: choose a position' })).getByRole(
      'button',
      { name: 'Move here' },
    ),
  );
  await waitFor(() => {
    expect(
      screen.queryByRole('dialog', { name: 'Move item: choose a position' }),
    ).not.toBeInTheDocument();
  });
  await userEvent.click(screen.getByRole('button', { name: 'Workspace' }));
  expect(await screen.findByRole('button', { name: 'Plan' })).toBeInTheDocument();
});
