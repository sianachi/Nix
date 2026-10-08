import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GraphExplorer, graphConnections } from '../../graph/graph-explorer';
import { stubViewport } from '../stub-viewport';
import { GraphView } from '../../graph/graph-view';
import { readGraphPresentation, writeGraphPresentation } from '../../graph/graph-presentation';
import { readArrangement, writeArrangement } from '../../graph/graph-arrangement';
import { memoryStorage } from '../views/suggest/suggest-fixtures';
beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});
afterEach(() => {
  vi.unstubAllGlobals();
});
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

it('switches every representation and supplies focus controls, scope and equivalent keyboard information', async () => {
  stubViewport(true);
  const user = userEvent.setup();
  const graphNodes = [
    ...nodes,
    { id: 'unrelated', title: 'Unrelated', parentId: null, type: 'note', ...DATES },
  ];
  render(
    <GraphExplorer workspaceId="layouts" nodes={graphNodes} links={[]} onOpen={vi.fn()} partial />,
  );
  const picker = screen.getByRole('combobox', { name: 'Graph layout' });
  await user.selectOptions(picker, 'focused');
  expect(screen.getByRole('combobox', { name: 'Focus item' })).toHaveValue('plan');
  expect(screen.getByRole('combobox', { name: 'Connection distance' })).toHaveValue('1');
  expect(
    screen.getByText(/2 of 3 loaded items within 1 connection step of Plan/),
  ).toHaveTextContent('loaded portion');
  const tree = screen.getByRole('tree');
  expect(within(tree).getByRole('button', { name: /Plan.*Focus item/ })).toBeInTheDocument();
  expect(within(tree).queryByRole('button', { name: /Unrelated/ })).not.toBeInTheDocument();
  await user.selectOptions(screen.getByRole('combobox', { name: 'Focus item' }), 'unrelated');
  expect(within(screen.getByRole('tree')).getAllByRole('treeitem')).toHaveLength(1);
  expect(readGraphPresentation('layouts').focusId).toBe('unrelated');
  await user.selectOptions(picker, 'hierarchy');
  expect(screen.getByText(/Parents above children/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Fold all' }));
  expect(within(screen.getByRole('tree')).getAllByRole('treeitem')).toHaveLength(2);
  await user.selectOptions(picker, 'clusters');
  expect(within(screen.getByRole('tree')).getAllByRole('treeitem')).toHaveLength(3);
  expect(
    within(screen.getByRole('tree')).getByRole('button', { name: /Plan.*Connection group/ }),
  ).toBeInTheDocument();
  await user.selectOptions(picker, 'chronological');
  expect(
    within(screen.getByRole('tree')).getByRole('button', { name: /Plan.*Created/ }),
  ).toBeInTheDocument();
  await user.selectOptions(picker, 'radial');
  expect(within(screen.getByRole('tree')).getAllByRole('treeitem')).toHaveLength(3);
});

it('restores workspace preferences, recovers from a removed focus item and resets on workspace changes', () => {
  stubViewport(true);
  writeGraphPresentation('first', { representation: 'focused', focusId: 'deleted', distance: 2 });
  writeGraphPresentation('second', { representation: 'chronological', focusId: null, distance: 1 });
  const props = { nodes, links: [], onOpen: vi.fn() };
  const { rerender } = render(<GraphExplorer {...props} workspaceId="first" />);
  expect(screen.getByRole('combobox', { name: 'Focus item' })).toHaveValue('plan');
  expect(screen.getByRole('combobox', { name: 'Connection distance' })).toHaveValue('2');
  rerender(<GraphExplorer {...props} workspaceId="second" />);
  expect(screen.getByRole('combobox', { name: 'Graph layout' })).toHaveValue('chronological');
});

it('opens focus mode from the phone list', async () => {
  stubViewport(false);
  const user = userEvent.setup();
  render(<GraphExplorer nodes={nodes} links={[]} onOpen={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: 'Focus graph on Plan' }));
  expect(screen.getByRole('combobox', { name: 'Graph layout' })).toHaveValue('focused');
  expect(screen.getByRole('combobox', { name: 'Focus item' })).toHaveValue('plan');
});

it('keeps timeline positions fixed during a drag and still opens an item on a click', () => {
  stubViewport(true);
  const onOpen = vi.fn();
  const onMove = vi.fn();
  const { container } = render(
    <GraphView
      nodes={nodes}
      links={[]}
      representation="chronological"
      onOpen={onOpen}
      onMove={onMove}
    />,
  );
  const disc = container.querySelector('svg > g.group');
  expect(disc).not.toBeNull();
  if (!disc) return;
  const startX = disc.querySelector('circle')?.getAttribute('cx');
  fireEvent.pointerDown(disc, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(disc, { pointerId: 1, clientX: 200, clientY: 180 });
  fireEvent.pointerUp(disc, { pointerId: 1, clientX: 200, clientY: 180 });
  expect(disc.querySelector('circle')?.getAttribute('cx')).toBe(startX);
  expect(screen.queryByRole('button', { name: 'Tidy up' })).not.toBeInTheDocument();
  expect(onOpen).not.toHaveBeenCalled();
  expect(onMove).not.toHaveBeenCalled();
  fireEvent.pointerDown(disc, { button: 0, pointerId: 2, clientX: 100, clientY: 100 });
  fireEvent.pointerUp(disc, { pointerId: 2, clientX: 100, clientY: 100 });
  expect(onOpen).toHaveBeenCalledWith('project');
});

it('reads separate saved arrangements for each layout and keeps the legacy radial entry', () => {
  const ids = new Set(nodes.map((node) => node.id));
  writeArrangement('workspace', {
    offsets: new Map(),
    collapsed: new Set(['project']),
    view: null,
  });
  writeArrangement('workspace:hierarchy', { offsets: new Map(), collapsed: new Set(), view: null });
  const props = { nodes, links: [], onOpen: vi.fn(), workspaceId: 'workspace' };
  const { rerender } = render(<GraphView {...props} representation="radial" />);
  expect(within(screen.getByRole('tree')).getAllByRole('treeitem')).toHaveLength(1);
  rerender(<GraphView {...props} representation="hierarchy" />);
  expect(within(screen.getByRole('tree')).getAllByRole('treeitem')).toHaveLength(2);
  fireEvent.keyDown(within(screen.getByRole('tree')).getByRole('button', { name: /Project,/ }), {
    key: 'ArrowLeft',
  });
  rerender(<GraphView {...props} representation="radial" />);
  rerender(<GraphView {...props} representation="hierarchy" />);
  expect(within(screen.getByRole('tree')).getAllByRole('treeitem')).toHaveLength(1);
  expect([...readArrangement('workspace', ids).collapsed]).toEqual(['project']);
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

it('brings the spatial graph into view after choosing an item from the phone list', async () => {
  stubViewport(false);
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  const scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoView,
  });

  try {
    const user = userEvent.setup();
    render(<GraphExplorer nodes={nodes} links={[]} onOpen={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Show Plan in graph' }));

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
  } finally {
    if (original === undefined) {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    } else {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', original);
    }
  }
});
