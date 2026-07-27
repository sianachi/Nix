import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '../app/app';
import { item, stubCoreApi } from '../test/api-stub';
import { renderAt, signedIn } from '../test/render-with-router';

/**
 * One item, open - and the claim that there is only one kind of it.
 *
 * The application used to fork here: a folder opened into its views and could not hold a document,
 * a note opened into an editor and could not hold anything. Neither restriction was ever in the
 * schema. What these tests hold is that the fork is gone and that its absence did not cost the
 * plain case anything - a note nobody has configured still opens straight into its body, with no
 * chrome asking it to choose between one option.
 */

beforeEach(() => {
  signedIn();
});

const NOTES = item({
  id: '2a2a2a2a-2222-4222-8222-2a2a2a2a2a2a',
  title: 'Roadmap',
  hasChildren: true,
});

const CHILD = item({
  id: '2b2b2b2b-2222-4222-8222-2b2b2b2b2b2b',
  title: 'Q1',
  parentId: NOTES.id,
});

const BOARD = {
  id: 'by-status',
  name: 'By status',
  kind: 'list',
  columns: [],
  groupBy: null,
  groupOrder: [],
  dateProperty: null,
  sortBy: null,
  sortDescending: false,
  mode: null,
};

describe('an item nobody has configured', () => {
  it('opens straight into its body, with nothing to choose between', async () => {
    stubCoreApi({ items: [NOTES, CHILD] });
    renderAt(<App />, `/?item=${NOTES.id}`);

    // The editor is what is on screen.
    expect(await screen.findByRole('textbox', { name: /note title/i })).toHaveValue('Roadmap');

    // And no switcher at all. A lone "Document" tab would be a control with one option, spending a
    // row of the screen to say what the screen already shows.
    await waitFor(() => {
      expect(screen.queryByRole('navigation', { name: /views/i })).not.toBeInTheDocument();
    });
  });

  it('offers its own properties and views to configure, even so', async () => {
    stubCoreApi({ items: [NOTES, CHILD] });
    renderAt(<App />, `/?item=${NOTES.id}`);

    // This is the unification's point: a note is a container the moment somebody wants it to be,
    // and it does not have to be converted into something else first. One control now rather than
    // two, because the panel it opens holds both - and "Properties" used to name two different
    // things, which is the collision the rename settles.
    expect(await screen.findByRole('button', { name: /settings/i })).toBeVisible();
  });
});

describe('an item with views', () => {
  it('offers its document alongside them', async () => {
    stubCoreApi({
      items: [NOTES, CHILD],
      views: { [NOTES.id]: { views: [BOARD], default: 'document' } },
    });
    renderAt(<App />, `/?item=${NOTES.id}`);

    const switcher = await screen.findByRole('navigation', { name: /views/i });

    expect(within(switcher).getByRole('button', { name: /document/i })).toBeVisible();
    expect(within(switcher).getByRole('button', { name: /by status/i })).toBeVisible();
  });

  it('opens on the one it says it opens on', async () => {
    stubCoreApi({
      items: [NOTES, CHILD],
      views: { [NOTES.id]: { views: [BOARD], default: 'by-status' } },
    });
    renderAt(<App />, `/?item=${NOTES.id}`);

    const switcher = await screen.findByRole('navigation', { name: /views/i });

    await waitFor(() => {
      expect(within(switcher).getByRole('button', { name: /by status/i })).toHaveAttribute(
        'aria-current',
        'page',
      );
    });

    // Its children, not its body.
    expect(await screen.findByText('Q1')).toBeVisible();
  });

  it('goes back to the body when the document is chosen', async () => {
    const user = userEvent.setup();
    stubCoreApi({
      items: [NOTES, CHILD],
      views: { [NOTES.id]: { views: [BOARD], default: 'by-status' } },
    });
    renderAt(<App />, `/?item=${NOTES.id}`);

    const switcher = await screen.findByRole('navigation', { name: /views/i });
    await user.click(within(switcher).getByRole('button', { name: /document/i }));

    await waitFor(() => {
      expect(within(switcher).getByRole('button', { name: /document/i })).toHaveAttribute(
        'aria-current',
        'page',
      );
    });
  });

  it('opens on its body when the stored default names a view it no longer has', async () => {
    stubCoreApi({
      items: [NOTES, CHILD],
      views: { [NOTES.id]: { views: [BOARD], default: 'deleted-one' } },
    });
    renderAt(<App />, `/?item=${NOTES.id}`);

    const switcher = await screen.findByRole('navigation', { name: /views/i });

    // The body, rather than whichever view happens to be first. Promoting a survivor would mean
    // deleting one view silently changed what the item opens as.
    await waitFor(() => {
      expect(within(switcher).getByRole('button', { name: /document/i })).toHaveAttribute(
        'aria-current',
        'page',
      );
    });
  });
});
