import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '../../app';
import { item, stubCoreApi } from '../api-stub';
import { renderAt, signedIn } from '../render-with-router';

/**
 * Making an item, and the two things that used to go wrong when it failed.
 *
 * There is one create path in the application, deliberately. It belongs to the tree, because the
 * tree is the only thing that knows how to put a new item into the store the sidebar reads and to
 * expand its parent so a child made inside a collapsed item is not invisible. A second
 * implementation living beside a view would have to get both right again.
 */

beforeEach(() => {
  signedIn();
});

const PARENT = item({
  id: '4a4a4a4a-4444-4444-8444-4a4a4a4a4a4a',
  title: 'Engineering',
  hasChildren: true,
});

const CHILD = item({
  id: '4b4b4b4b-4444-4444-8444-4b4b4b4b4b4b',
  title: 'Roadmap',
  parentId: PARENT.id,
});

describe('creating an item', () => {
  it('puts it in the tree without collapsing what was open', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [PARENT, CHILD] });
    renderAt(<App />);

    await user.click(await screen.findByRole('button', { name: /expand engineering/i }));
    expect(await screen.findByRole('button', { name: 'Roadmap' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: /new item in the workspace/i }));
    await user.click(await screen.findByRole('menuitem', { name: /new note in the workspace/i }));

    // `tree.reload()` re-fetches roots and empties the expanded set, so calling it after a create
    // would close every folder somebody had opened to get here. `tree.create` puts the item into
    // the store itself, which is why it must not be followed by a reload.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Roadmap' })).toBeVisible();
    });
  });

  it('opens the parent so a child made inside a closed one is not invisible', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [PARENT, CHILD] });
    renderAt(<App />, `/?item=${PARENT.id}`);

    // Open the parent without expanding it, so the new child lands somewhere closed.
    await screen.findByRole('button', { name: 'Engineering' });

    await user.click(screen.getByRole('button', { name: /new item in the workspace/i }));
    await user.click(screen.getByRole('menuitemcheckbox', { name: /create inside engineering/i }));
    await user.click(await screen.findByRole('menuitem', { name: /new note inside engineering/i }));

    // A creation you cannot see reads as a creation that failed.
    expect(await screen.findByRole('button', { name: /collapse engineering/i })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Untitled note' }).closest('ul')).toHaveAttribute(
      'role',
      'group',
    );
  });

  it('says what the server said when it refuses', async () => {
    const user = userEvent.setup();
    stubCoreApi({
      items: [PARENT],
      createRefusal: 'Status must be one of Todo, Doing, Done.',
    });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Engineering' });
    await user.click(screen.getByRole('button', { name: /new item in the workspace/i }));
    await user.click(await screen.findByRole('menuitem', { name: /new note in the workspace/i }));

    // The server's own sentence, beside the control that was pressed. It used to report the status
    // code alone - "(422)" in place of a sentence naming the property at fault - and it used to put
    // it in the tree-wide error, which renders at the foot of the sidebar.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Status must be one of Todo, Doing, Done.',
    );

    expect(screen.queryByText(/\(422\)/)).not.toBeInTheDocument();
  });

  it('clears a previous refusal when the next attempt is made', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [PARENT], createRefusal: 'Status must be one of Todo, Doing, Done.' });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Engineering' });

    async function createNote(): Promise<void> {
      await user.click(screen.getByRole('button', { name: /new item in the workspace/i }));
      await user.click(await screen.findByRole('menuitem', { name: /new note in the workspace/i }));
    }

    await createNote();
    expect(await screen.findByRole('alert')).toBeVisible();

    // A refusal left on screen through the next attempt describes a request that is no longer
    // happening, and somebody reads it as the new one having failed too.
    await createNote();
    await waitFor(() => {
      expect(screen.getAllByRole('alert')).toHaveLength(1);
    });
  });
});

describe('the new-item menu', () => {
  it('supports menu arrow keys and returns focus to New on Escape', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [PARENT] });
    renderAt(<App />, `/?item=${PARENT.id}`);

    await screen.findByRole('button', { name: 'Engineering' });
    const trigger = screen.getByRole('button', { name: /new item in the workspace/i });
    await user.click(trigger);

    const destination = screen.getByRole('menuitemcheckbox', {
      name: /create inside engineering/i,
    });
    expect(destination).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: /new note in the workspace/i })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('menuitem', { name: /browse all templates/i })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(destination).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('offers every kind the client can draw, and closes once one is chosen', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [PARENT] });
    renderAt(<App />, `/?item=${PARENT.id}`);

    await screen.findByRole('button', { name: 'Engineering' });
    await user.click(screen.getByRole('button', { name: /new item in the workspace/i }));

    // A body kind with no way to create an item of it is a body kind nobody can use.
    expect(screen.getByRole('menuitem', { name: /new note in the workspace/i })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: /new canvas in the workspace/i })).toBeVisible();
    expect(
      screen.getByRole('menuitem', { name: /new spreadsheet in the workspace/i }),
    ).toBeVisible();
    expect(
      screen.getByRole('menuitemcheckbox', { name: /create inside engineering/i }),
    ).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('menu')).toHaveTextContent('Templates');
    expect(
      await screen.findByRole('menuitem', { name: /new kanban in the workspace/i }),
    ).toBeVisible();
    expect(screen.getByRole('menuitem', { name: /new calendar in the workspace/i })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: /new list in the workspace/i })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: /upload files/i })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: /browse all templates/i })).toBeVisible();
    expect(screen.getAllByRole('menuitem')).toHaveLength(15);
    expect(screen.queryByText('Today')).not.toBeInTheDocument();
    expect(screen.queryByText('Next 7 days')).not.toBeInTheDocument();
    expect(screen.queryByText('Overdue')).not.toBeInTheDocument();

    await user.click(screen.getByRole('menuitem', { name: /new note in the workspace/i }));

    // A menu still open over the tree would cover the item it just created.
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
  });

  it('creates from a library template through a reviewable wizard', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [PARENT] });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Engineering' });
    await user.click(screen.getByRole('button', { name: /new item in the workspace/i }));
    await user.click(await screen.findByRole('menuitem', { name: /new kanban in the workspace/i }));

    expect(await screen.findByRole('heading', { name: /create from kanban/i })).toBeVisible();
    expect(screen.getByText(/destination: workspace root/i)).toBeVisible();
    expect(screen.getByRole('navigation', { name: /template steps/i })).toBeVisible();
    expect(screen.getByRole('textbox', { name: /name/i })).toHaveValue('Kanban');

    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByRole('heading', { name: /what this template adds/i })).toBeVisible();
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByRole('heading', { name: /review/i })).toBeVisible();
    await user.click(screen.getByRole('button', { name: /create item/i }));

    expect(await screen.findByDisplayValue('Kanban')).toBeVisible();
  });

  it('closes on Escape without creating anything', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [PARENT] });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Engineering' });
    const trigger = screen.getByRole('button', { name: /new item in the workspace/i });

    await user.click(trigger);
    expect(screen.getByRole('menu')).toBeVisible();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });
});
