import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderAt } from '../test/render-with-router';
import { aContainer, views as offered } from '../views/container-fixture';
import type { View } from '../views/container-model';
import type * as UseContainer from '../views/use-container';
import type { ContainerData } from '../views/use-container';
import { ContainerPage } from './container-page';

/**
 * Which view opens, and - the part that carries real risk - when that gets written down.
 *
 * The stored default is workspace-wide state that a single click changes. The rule these tests hold
 * is that only a *deliberate* click changes it: arriving at a URL that already names a view must
 * write nothing at all, because otherwise following a link somebody shared would silently rewrite
 * what the item opens as for everybody, on behalf of the person who followed it.
 *
 * The negative test is the important one. The positive one only proves the feature exists.
 */

const ALL: View = {
  id: 'all',
  name: 'All',
  kind: 'list',
  columns: [],
  groupBy: null,
  groupOrder: [],
  dateProperty: null,
  sortBy: null,
  sortDescending: false,
};

const BY_STATUS: View = { ...ALL, id: 'by-status', name: 'By status' };

let container: ContainerData;
let setDefaultView: ReturnType<typeof vi.fn>;

vi.mock('../views/use-container', async (importOriginal) => ({
  ...(await importOriginal<typeof UseContainer>()),
  useContainer: () => container,
}));

beforeEach(() => {
  setDefaultView = vi.fn(() => Promise.resolve(null));
  container = aContainer({
    views: offered([ALL, BY_STATUS]),
    setDefaultView,
  });
});

describe('which view opens', () => {
  it('writes the default when somebody deliberately switches', async () => {
    const user = userEvent.setup();
    renderAt(<ContainerPage containerId="item-1" onOpen={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /by status/i }));

    expect(setDefaultView).toHaveBeenCalledWith('by-status');
  });

  it('writes nothing when a shared link already names a view', async () => {
    // The whole risk of making this sticky. Somebody sends "look at the board" and the person who
    // opens it changes what the item opens as for the entire workspace, having chosen nothing.
    renderAt(<ContainerPage containerId="item-1" onOpen={vi.fn()} />, '/?view=by-status');

    // The board is what is on screen, so the URL was honoured...
    expect(await screen.findByRole('button', { name: /by status/i })).toHaveAttribute(
      'aria-current',
      'page',
    );

    // ...and nothing was written down about it.
    await waitFor(() => {
      expect(setDefaultView).not.toHaveBeenCalled();
    });
  });

  it('asks to store the clicked view without deciding whether that is a change', async () => {
    const user = userEvent.setup();
    container = aContainer({
      views: offered([ALL, BY_STATUS], { default: 'by-status' }),
      setDefaultView,
    });

    renderAt(<ContainerPage containerId="item-1" onOpen={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /by status/i }));

    // Clicking the tab that is already the default still asks. Skipping the request when nothing
    // would change is `setDefaultView`'s own job, in use-container, where the stored value is
    // known - this screen would have to duplicate that knowledge to decide it here.
    expect(setDefaultView).toHaveBeenCalledWith('by-status');
  });
});

describe('a view this build cannot draw', () => {
  it('says so rather than drawing something else', async () => {
    container = aContainer({
      views: offered([{ ...ALL, id: 'sketch', name: 'Sketch', kind: 'canvas' }]),
    });

    renderAt(<ContainerPage containerId="item-1" onOpen={vi.fn()} />, '/?view=sketch');

    // Before the registry this fell through a switch's default arm and rendered as a list, which
    // looked like it had worked and quietly lied about what the view was.
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot render that view/i);
  });
});
