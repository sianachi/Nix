import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { CanvasBrowser, canvasEntries } from '../../editor/canvas-browser';
import type { CanvasElement } from '../../editor/canvas-binding';

const elements: CanvasElement[] = [
  { id: 'text', type: 'text', version: 1, versionNonce: 1, text: 'Think about the next release' },
  { id: 'card', type: 'card', version: 1, versionNonce: 1, itemId: 'plan', title: 'Release plan' },
  { id: 'gone', type: 'text', version: 1, versionNonce: 1, text: 'Deleted', isDeleted: true },
];
it('reads legacy text and item cards without changing the scene', () => {
  const before = structuredClone(elements);
  const { entries } = canvasEntries(elements);
  expect(entries.map((entry) => entry.title)).toEqual([
    'Think about the next release',
    'Release plan',
  ]);
  expect(elements).toEqual(before);
});
it('finds canvas content and opens linked items', async () => {
  const onOpen = vi.fn();
  render(<CanvasBrowser elements={elements} onOpen={onOpen} onSpatial={vi.fn()} loading={false} />);
  const user = userEvent.setup();
  await user.type(screen.getByRole('searchbox', { name: 'Find in canvas' }), 'plan');
  await user.click(screen.getByRole('button', { name: 'Release plan' }));
  expect(onOpen).toHaveBeenCalledWith('plan');
  expect(screen.queryByText('Think about the next release')).not.toBeInTheDocument();
});
