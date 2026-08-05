import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../app/app';
import { item, stubCoreApi } from '../test/api-stub';
import { renderAt, signedIn } from '../test/render-with-router';
import { stubViewport } from '../test/stub-viewport';

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

// A note that holds another note. It used to be typed 'folder', which is what earned it an expand
// control; the control now comes from whether it actually has children, which is the fact the
// server reports and the only one that cannot be wrong.
const PARENT = item({
  id: '1a1a1a1a-1111-4111-8111-1a1a1a1a1a1a',
  title: 'Engineering',
  hasChildren: true,
});

const CHILD = item({
  id: '1b1b1b1b-1111-4111-8111-1b1b1b1b1b1b',
  title: 'Roadmap',
  parentId: PARENT.id,
});

describe('creating an item', () => {
  it('puts it in the workspace when nothing is selected', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [PARENT] });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Engineering' });

    expect(screen.getByRole('button', { name: /new item in the workspace/i })).toBeVisible();
    await user.click(screen.getByRole('button', { name: /new item in the workspace/i }));
    await user.click(await screen.findByRole('menuitem', { name: /new note in the workspace/i }));
  });

  it('puts it inside the item you are looking at', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [PARENT, CHILD] });
    renderAt(<App />);

    await user.click(await screen.findByRole('button', { name: 'Engineering' }));

    // Creating always at the root made putting anything inside anything impossible without a drag.
    // The label says where it will land, so the control does not depend on an invisible selection.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /new item in engineering/i })).toBeVisible();
    });
  });

  it('puts it inside a nested item too, rather than beside it', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [PARENT, CHILD] });
    renderAt(<App />);

    await user.click(await screen.findByRole('button', { name: /expand engineering/i }));
    await user.click(await screen.findByRole('button', { name: 'Roadmap' }));

    // This test used to assert the opposite - that a new item landed *beside* Roadmap, in
    // Engineering - because a note could not hold anything and the sibling position was the only
    // sensible reading. Every item can hold children now, so "inside what you are looking at" is
    // one rule instead of two, and it is the one a file manager already taught everybody.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /new item in roadmap/i })).toBeVisible();
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
    stubCoreApi({ items: [PARENT, CHILD] });
    renderAt(<App />, `/?item=${CHILD.id}`);

    const trail = await screen.findByRole('navigation', { name: /breadcrumb/i });
    const up = await within(trail).findByRole('button', { name: 'Engineering' });

    await user.click(up);

    // A trail that shows where you are and cannot take you there is a label pretending to be a
    // control, and everybody tries to click it.
    //
    // Asserted on the title field, which is the item that is open. This used to assert on a
    // container region instead, because a folder opened into its views and a note did not - a
    // distinction that no longer exists, and the assertion went with it. The trail itself is the
    // second half: the ancestor is now the last crumb rather than a clickable one, so the screen
    // agrees about where it is.
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: /note title/i })).toHaveValue('Engineering');
    });

    expect(within(trail).queryByRole('button', { name: 'Engineering' })).not.toBeInTheDocument();
  });
});

describe('opening an item beside another', () => {
  it('does not render the control at all on a narrow screen, since a phone never has room for a second pane', async () => {
    const user = userEvent.setup();
    stubViewport(false);
    stubCoreApi({ items: [PARENT] });
    renderAt(<App />);

    await user.click(await screen.findByRole('button', { name: /show the workspace tree/i }));
    await screen.findByRole('button', { name: 'Engineering' });

    // `'narrow'` is a fact about this viewport, true of every row at once - unlike the pane limit
    // below, it is never going to stop being true without the window itself changing size, so a
    // disabled control here would be permanently visible and permanently useless, and a screen
    // reader would hear its refusal read out on every row in the tree.
    expect(
      screen.queryByRole('button', { name: /open engineering beside/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /cannot open engineering beside/i }),
    ).not.toBeInTheDocument();

    // The row's other controls are unaffected by this - they still work at narrow widths.
    expect(screen.getByRole('button', { name: /delete engineering/i })).toBeInTheDocument();
  });

  it('keeps the control visible and disabled at the pane limit, since that refusal is transient', async () => {
    const A = item({ id: '2a2a2a2a-2222-4222-8222-2a2a2a2a2a2a', title: 'Alpha' });
    const B = item({ id: '2b2b2b2b-2222-4222-8222-2b2b2b2b2b2b', title: 'Bravo' });
    const C = item({ id: '2c2c2c2c-2222-4222-8222-2c2c2c2c2c2c', title: 'Charlie' });
    const D = item({ id: '2d2d2d2d-2222-4222-8222-2d2d2d2d2d2d', title: 'Delta' });
    stubCoreApi({ items: [A, B, C, D] });
    renderAt(<App />, `/?item=${A.id}&item2=${B.id}&item3=${C.id}`);

    await screen.findByRole('button', { name: 'Delta' });

    // Unlike the narrow case above, three panes already open is a state of this arrangement, not
    // of this window - closing one changes the answer - so the control stays put, disabled, and
    // says why.
    expect(screen.getByRole('button', { name: /cannot open delta beside/i })).toBeDisabled();
  });
});

describe('deleting an item', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks first', async () => {
    const user = userEvent.setup();
    const confirm = vi.fn(() => false);
    stubCoreApi({ items: [PARENT] });
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
    stubCoreApi({ items: [PARENT, CHILD] });
    renderAt(<App />);

    await user.click(await screen.findByRole('button', { name: /expand engineering/i }));
    await screen.findByRole('button', { name: 'Roadmap' });

    vi.stubGlobal('confirm', confirm);
    await user.click(screen.getByRole('button', { name: /delete engineering/i }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('1 item'));
  });

  it('does nothing when the answer is no', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [PARENT] });
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
