import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';

import { ContainerView } from '../../../views/core/container-view';
import { aContainer } from '../../container-fixture';
import { item } from '../../api-stub';
import { renderAt } from '../../render-with-router';
import { stubViewport } from '../../stub-viewport';
import { aView } from '../../view-fixture';

beforeEach(() => {
  stubViewport(true);
});

const row = item({ id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', title: 'First' });

it('opens a tab-mode row as a pinned tab', async () => {
  const onOpen = vi.fn();
  const onOpenPinned = vi.fn();
  renderAt(
    <ContainerView
      container={aContainer({ children: [row] })}
      view={aView({ kind: 'list', open: 'tab' })}
      onOpen={onOpen}
      onOpenPinned={onOpenPinned}
    />,
  );
  await userEvent.setup().click(screen.getByRole('button', { name: 'First' }));
  expect(onOpenPinned).toHaveBeenCalledWith(row.id);
  expect(onOpen).not.toHaveBeenCalled();
});

it('falls back to the plain open when no host can pin a tab', async () => {
  const onOpen = vi.fn();
  renderAt(
    <ContainerView
      container={aContainer({ children: [row] })}
      view={aView({ kind: 'list', open: 'tab' })}
      onOpen={onOpen}
    />,
  );
  await userEvent.setup().click(screen.getByRole('button', { name: 'First' }));
  expect(onOpen).toHaveBeenCalledWith(row.id);
});
