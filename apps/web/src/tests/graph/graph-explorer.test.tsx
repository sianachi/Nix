import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { GraphExplorer, graphConnections } from '../../graph/graph-explorer';
import { stubViewport } from '../stub-viewport';
const DATES = {
  createdAt: '2026-01-01T00:00:00+00:00',
  lastModifiedAt: '2026-01-01T00:00:00+00:00',
};

const nodes = [
  { id: 'project', title: 'Project', parentId: null, type: 'note', ...DATES },
  { id: 'plan', title: 'Plan', parentId: 'project', type: 'note', ...DATES },
];
it('indexes both directions of structural and reference connections', () => {
  const connections = graphConnections(nodes, [
    { sourceId: 'plan', targetId: 'project', occurrences: 1 },
  ]);
  expect(connections.get('plan')).toEqual([
    { id: 'project', relation: 'Inside' },
    { id: 'project', relation: 'Links to' },
  ]);
  expect(connections.get('project')).toEqual([
    { id: 'plan', relation: 'Contains' },
    { id: 'plan', relation: 'Linked from' },
  ]);
});
it('defaults to searchable browsing on phones and opens items through the supplied dialog action', async () => {
  stubViewport(false);
  const onOpen = vi.fn();
  const user = userEvent.setup();
  render(<GraphExplorer nodes={nodes} links={[]} onOpen={onOpen} />);
  expect(screen.getByRole('button', { name: 'Browse connections' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(screen.queryByRole('button', { name: 'Zoom in' })).not.toBeInTheDocument();
  await user.type(screen.getByRole('searchbox', { name: 'Find an item' }), 'Plan');
  await user.click(screen.getByRole('button', { name: 'Plan' }));
  expect(onOpen).toHaveBeenCalledWith('plan');
});
