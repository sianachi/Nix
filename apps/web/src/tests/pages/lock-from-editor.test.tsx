import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '../../app';
import { item, stubCoreApi } from '../api-stub';
import { renderAt, signedIn } from '../render-with-router';

/**
 * A locked note, from the application: the prompt stands where the body would be, the controls that
 * reach the body are withheld, and the right password brings them back.
 */

beforeEach(() => {
  signedIn();
});

const NOTE = item({
  id: '5e5e5e5e-5555-4555-8555-5e5e5e5e5e5e',
  title: 'Diary',
});

describe('a locked note, from the page', () => {
  it('shows the password prompt instead of the body, and no history', async () => {
    stubCoreApi({ items: [NOTE], lockedItems: [NOTE.id] });
    renderAt(<App />, `/?item=${NOTE.id}`);

    expect(await screen.findByRole('heading', { name: 'Diary is locked' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Lock/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^History$/ })).not.toBeInTheDocument();
  });

  it('opens with the right password and offers the lock controls again', async () => {
    stubCoreApi({ items: [NOTE], lockedItems: [NOTE.id] });
    renderAt(<App />, `/?item=${NOTE.id}`);

    await userEvent.type(await screen.findByLabelText('Password'), 'hunter22');
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }));

    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Diary is locked' })).not.toBeInTheDocument();
    });
    expect(await screen.findByRole('button', { name: /^History$/ })).toBeInTheDocument();
    const settings = screen.getByRole('button', { name: /^Lock settings, open until / });
    // Focus lands on the control that now stands for the open body, not on nothing.
    await waitFor(() => {
      expect(settings).toHaveFocus();
    });
  });

  it('offers to lock a note that has no lock', async () => {
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, `/?item=${NOTE.id}`);

    expect(await screen.findByRole('button', { name: 'Lock this note' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Diary is locked' })).not.toBeInTheDocument();
  });
});
