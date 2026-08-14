import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '../../app';
import { item, stubCoreApi } from '../api-stub';
import { renderAt, signedIn } from '../render-with-router';

/**
 * Exporting, from the application rather than from a module nobody reaches.
 *
 * The dialog and the request module existed for a long time with nothing mounting them, which meant
 * the feature was complete in every sense except being usable. This is the test that would have
 * failed then, and the one that fails again if the control is ever removed.
 */

beforeEach(() => {
  signedIn();
});

const NOTE = item({
  id: '3c3c3c3c-3333-4333-8333-3c3c3c3c3c3c',
  title: 'Quarterly Review',
});

describe('exporting the document being read', () => {
  it('offers Export beside the document, not buried in a menu', async () => {
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, `/?item=${NOTE.id}`);

    expect(await screen.findByRole('button', { name: /Export/ })).toBeInTheDocument();
  });

  it('opens the dialog, which asks for a format before anything else', async () => {
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, `/?item=${NOTE.id}`);

    await userEvent.click(await screen.findByRole('button', { name: /Export/ }));

    await waitFor(() => {
      expect(screen.getByRole('group', { name: 'Format' })).toBeInTheDocument();
    });
  });

  it('does not ask what to include for an item with nothing inside it', async () => {
    // One honest answer, so it is not offered as a question.
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, `/?item=${NOTE.id}`);

    await userEvent.click(await screen.findByRole('button', { name: /Export/ }));

    await waitFor(() => {
      expect(screen.getByRole('group', { name: 'Format' })).toBeInTheDocument();
    });
    expect(screen.queryByRole('group', { name: 'What to export' })).not.toBeInTheDocument();
  });
});
