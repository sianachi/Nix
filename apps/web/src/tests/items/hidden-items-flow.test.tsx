import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../app';
import { item, stubCoreApi, STUB_WORKSPACE_ID } from '../api-stub';
import { renderAt, signedIn } from '../render-with-router';
import { memoryStorage } from '../views/suggest/suggest-fixtures';
import { stubViewport } from '../stub-viewport';
import { hiddenItemsKey, writeHiddenItems } from '../../lib/view-hidden-items';

const NOTE = item({ id: '1e1e1e1e-1111-4111-8111-1e1e1e1e1e1e', title: 'Meeting notes' });

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  signedIn();
  stubViewport(true);
  writeHiddenItems(hiddenItemsKey('test-subject', STUB_WORKSPACE_ID), []);
});

describe('hiding saved notes for yourself', () => {
  it('removes a note from everyday navigation while keeping it open and recoverable', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, `/?item=${NOTE.id}`);
    expect(await screen.findByRole('textbox', { name: 'Note title' })).toHaveValue('Meeting notes');
    await user.click(screen.getByRole('button', { name: 'Item actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Hide for me' }));
    await waitFor(() => {
      expect(screen.queryByRole('tree', { name: 'Items' })).not.toBeInTheDocument();
    });
    expect(screen.getByRole('textbox', { name: 'Note title' })).toHaveValue('Meeting notes');
    await user.click(screen.getByRole('button', { name: 'Item actions' }));
    expect(screen.getByRole('menuitem', { name: 'Show for me' })).toBeVisible();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Workspace options' }));
    await user.click(screen.getByRole('menuitem', { name: 'Hidden items (1)' }));
    const manager = await screen.findByRole('region', { name: 'Hidden items' });
    await user.click(
      await within(manager).findByRole('button', { name: 'Show Meeting notes again' }),
    );
    expect(await screen.findByRole('tree', { name: 'Items' })).toHaveTextContent('Meeting notes');
  });

  it('keeps direct routes working for a hidden note after reopening the application', async () => {
    writeHiddenItems(hiddenItemsKey('test-subject', STUB_WORKSPACE_ID), [NOTE.id]);
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, `/?item=${NOTE.id}`);
    expect(await screen.findByRole('textbox', { name: 'Note title' })).toHaveValue('Meeting notes');
    await userEvent.click(screen.getByRole('button', { name: 'Item actions' }));
    expect(screen.getByRole('menuitem', { name: 'Show for me' })).toBeVisible();
  });
});
