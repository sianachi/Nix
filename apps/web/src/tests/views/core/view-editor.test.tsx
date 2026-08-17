import { render as renderUi, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import type { View } from '../../../views/core/container-model';
import type { ContainerData } from '../../../views/core/use-container';
import { ViewEditor } from '../../../views/core/view-editor';
import { aContainer, views as offered } from '../../container-fixture';
import { aView } from '../../view-fixture';

function viewOf(overrides: Partial<View> & { id: string; name: string }): View {
  return aView(overrides);
}

function render(ui: ReactNode): ReturnType<typeof renderUi> {
  return renderUi(
    <MemoryRouter>
      {ui}
      <RouteProbe />
    </MemoryRouter>,
  );
}

function RouteProbe(): ReactNode {
  const location = useLocation();
  return <output aria-label="Current route">{location.pathname}</output>;
}

function containerOf(
  views: readonly View[],
  setViews: (next: readonly View[]) => Promise<string | null> = () => Promise.resolve(null),
): ContainerData {
  return aContainer({ views: offered(views), setViews });
}

describe('the view editor', () => {
  it('keeps templates out of the Views panel', () => {
    render(<ViewEditor container={containerOf([])} open onClose={vi.fn()} />);

    expect(screen.getByText(/no child-item views yet/i)).toBeVisible();
    expect(screen.queryByText(/start from a template/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /kanban board/i })).not.toBeInTheDocument();
  });

  it('starts guided creation for a new view', async () => {
    const user = userEvent.setup();
    const setViews = vi.fn(() => Promise.resolve(null));

    render(<ViewEditor container={containerOf([], setViews)} open onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /add a view/i }));
    await user.click(screen.getByRole('button', { name: /^list/i }));

    expect(screen.getByRole('status', { name: /current route/i })).toHaveTextContent(
      '/items/container-1/views/new/list',
    );
    expect(setViews).not.toHaveBeenCalled();
  });

  it.each([
    ['list', 'list'],
    ['board', 'board'],
    ['calendar', 'calendar'],
    ['timeline', 'timeline'],
    ['gallery', 'gallery'],
    ['sheet', 'sheet'],
    ['form', 'form'],
    ['query', 'query'],
    ['interactive_form', 'interactive-form'],
  ])('configures an existing %s view in its wizard', async (kind, recipe) => {
    const user = userEvent.setup();
    render(
      <ViewEditor
        container={containerOf([viewOf({ id: 'configured-view', name: 'Work', kind })])}
        open
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Configure' }));

    expect(screen.getByRole('status', { name: /current route/i })).toHaveTextContent(
      `/items/container-1/views/configured-view/edit/${recipe}`,
    );
  });

  it('shows a compact summary instead of inline configuration fields', () => {
    render(
      <ViewEditor
        container={containerOf([
          viewOf({
            id: 'delivery',
            name: 'Delivery plan',
            kind: 'timeline',
            companionViewId: 'details',
          }),
        ])}
        open
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Delivery plan')).toBeVisible();
    expect(screen.getByText(/timeline.*has companion/i)).toBeVisible();
    expect(screen.queryByRole('combobox', { name: /starts on/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Configure' })).toBeVisible();
  });

  it('reorders views in the panel', async () => {
    const user = userEvent.setup();
    const setViews = vi.fn(() => Promise.resolve(null));
    render(
      <ViewEditor
        container={containerOf(
          [viewOf({ id: 'first', name: 'First' }), viewOf({ id: 'second', name: 'Second' })],
          setViews,
        )}
        open
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: /move second earlier/i }));
    await user.click(screen.getByRole('button', { name: /save views/i }));

    expect(setViews).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'second' }),
      expect.objectContaining({ id: 'first' }),
    ]);
  });

  it('removes a view in the panel', async () => {
    const user = userEvent.setup();
    const setViews = vi.fn(() => Promise.resolve(null));
    render(
      <ViewEditor
        container={containerOf([viewOf({ id: 'gone', name: 'Gone' })], setViews)}
        open
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: /remove gone/i }));
    await user.click(screen.getByRole('button', { name: /save views/i }));

    expect(setViews).toHaveBeenCalledWith([]);
  });

  it('clears a primary composition in the same save that removes its companion', async () => {
    const user = userEvent.setup();
    const setViews = vi.fn(() => Promise.resolve(null));
    render(
      <ViewEditor
        container={containerOf(
          [
            viewOf({
              id: 'primary',
              name: 'Primary',
              companionViewId: 'companion',
              companionPlacement: 'beside',
            }),
            viewOf({ id: 'companion', name: 'Companion' }),
          ],
          setViews,
        )}
        open
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: /remove companion/i }));
    await user.click(screen.getByRole('button', { name: /save views/i }));

    expect(setViews).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'primary',
        companionViewId: null,
        companionPlacement: null,
      }),
    ]);
  });
});
