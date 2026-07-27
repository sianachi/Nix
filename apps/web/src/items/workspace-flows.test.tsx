import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../app/app';
import { item, stubCoreApi } from '../test/api-stub';
import { renderAt, signedIn } from '../test/render-with-router';

/**
 * The flows, rather than the pixels.
 *
 * Each of these was a hole somebody would fall into rather than a thing that looked wrong: an item
 * that could only ever be created at the workspace root, a trail that showed where you were and
 * refused to take you there, a delete button revealed on hover with nothing between it and the
 * deletion, and a new item left called "Untitled note" for you to go and find.
 */
beforeEach(() => {
  signedIn();
});

const FOLDER = item({
  id: '1a1a1a1a-1111-4111-8111-1a1a1a1a1a1a',
  title: 'Engineering',
  type: 'folder',
});

const CHILD = item({
  id: '1b1b1b1b-1111-4111-8111-1b1b1b1b1b1b',
  title: 'Roadmap',
  parentId: FOLDER.id,
});

describe('creating an item', () => {
  it('puts it in the workspace when nothing is selected', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [FOLDER] });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Engineering' });

    expect(screen.getByRole('button', { name: /new note in the workspace/i })).toBeVisible();
    await user.click(screen.getByRole('button', { name: /new note in the workspace/i }));
  });

  it('puts it inside the folder you are looking at', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [FOLDER, CHILD] });
    renderAt(<App />);

    await user.click(await screen.findByRole('button', { name: 'Engineering' }));

    // Creating always at the root made putting anything inside a folder impossible without a drag.
    // The label says where it will land, so the control does not depend on an invisible selection.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /new note in engineering/i })).toBeVisible();
    });
  });

  it('puts it beside the note you are looking at, not inside it', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [FOLDER, CHILD] });
    renderAt(<App />);

    await user.click(await screen.findByRole('button', { name: /expand engineering/i }));
    await user.click(await screen.findByRole('button', { name: 'Roadmap' }));

    // A note is not a container, so the sibling position is the only sensible reading of "new note
    // here" - and it is what a file manager does.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /new note in engineering/i })).toBeVisible();
    });
  });
});

describe('naming a new item', () => {
  it('selects the placeholder name so it can be typed over', async () => {
    stubCoreApi({
      items: [item({ id: '1c1c1c1c-1111-4111-8111-1c1c1c1c1c1c', title: 'Untitled note' })],
    });
    renderAt(<App />, '/?item=1c1c1c1c-1111-4111-8111-1c1c1c1c1c1c');

    const title = await screen.findByRole('textbox', { name: /note title/i });

    // Selected rather than cleared: renaming is one keystroke, and somebody who came to read
    // instead loses nothing by clicking away.
    await waitFor(() => {
      expect(title).toHaveFocus();
    });
  });

  it('leaves a named item alone', async () => {
    stubCoreApi({ items: [CHILD] });
    renderAt(<App />, `/?item=${CHILD.id}`);

    const title = await screen.findByRole('textbox', { name: /note title/i });

    // Stealing focus every time somebody opened a note would fight anyone trying to read one.
    await waitFor(() => {
      expect(title).not.toHaveFocus();
    });
  });
});

describe('the breadcrumb trail', () => {
  it('takes you to an ancestor', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [FOLDER, CHILD] });
    renderAt(<App />, `/?item=${CHILD.id}`);

    const trail = await screen.findByRole('navigation', { name: /breadcrumb/i });
    const up = await within(trail).findByRole('button', { name: 'Engineering' });

    await user.click(up);

    // A trail that shows where you are and cannot take you there is a label pretending to be a
    // control, and everybody tries to click it. Asserted on the container region rather than on the
    // title, because a folder opens into its views and a note does not - so this says the ancestor
    // was actually opened rather than merely named somewhere on screen.
    expect(await screen.findByRole('region', { name: /container/i })).toBeVisible();
  });
});

describe('deleting an item', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks first', async () => {
    const user = userEvent.setup();
    const confirm = vi.fn(() => false);
    stubCoreApi({ items: [FOLDER] });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Engineering' });
    vi.stubGlobal('confirm', confirm);

    await user.click(screen.getByRole('button', { name: /delete engineering/i }));

    // The control is revealed on hover and sits a few pixels from the one that opens the item.
    // Deletion is reversible in the database and nothing in the interface offers the way back yet,
    // so from here it reads as permanent.
    expect(confirm).toHaveBeenCalled();
  });

  it('says how much goes with it', async () => {
    const user = userEvent.setup();
    const confirm = vi.fn(() => false);
    stubCoreApi({ items: [FOLDER, CHILD] });
    renderAt(<App />);

    await user.click(await screen.findByRole('button', { name: /expand engineering/i }));
    await screen.findByRole('button', { name: 'Roadmap' });

    vi.stubGlobal('confirm', confirm);
    await user.click(screen.getByRole('button', { name: /delete engineering/i }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('1 item'));
  });

  it('does nothing when the answer is no', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [FOLDER] });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Engineering' });
    vi.stubGlobal(
      'confirm',
      vi.fn(() => false),
    );

    await user.click(screen.getByRole('button', { name: /delete engineering/i }));

    expect(screen.getByRole('button', { name: 'Engineering' })).toBeVisible();
  });
});
