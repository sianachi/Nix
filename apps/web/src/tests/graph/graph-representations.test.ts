import type { GraphLink, GraphNode } from '@nix/api-client';
import { describe, expect, it } from 'vitest';
import { fitCamera } from '../../graph/graph-camera';
import {
  connectionGroups,
  focusGraph,
  representationScene,
  type GraphRepresentation,
} from '../../graph/graph-representations';

function node(id: string, parentId: string | null = null, day = 1): GraphNode {
  return {
    id,
    parentId,
    title: id,
    type: 'note',
    createdAt: new Date(Date.UTC(2026, 0, day)).toISOString(),
    lastModifiedAt: null,
  };
}
function link(sourceId: string, targetId: string, occurrences = 1): GraphLink {
  return { sourceId, targetId, occurrences };
}
const modes: GraphRepresentation[] = ['focused', 'hierarchy', 'clusters', 'chronological'];

describe('focused connections', () => {
  const nodes = [
    node('parent'),
    node('focus', 'parent'),
    node('child', 'focus'),
    node('incoming'),
    node('distant'),
    node('unrelated'),
  ];
  const links = [
    link('incoming', 'focus'),
    link('incoming', 'distant'),
    link('focus', 'focus'),
    link('missing', 'focus'),
  ];
  it('finds incoming, outgoing and structural neighbours by shortest path without dangling edges', () => {
    const scope = focusGraph(nodes, links, 'focus', 1);
    expect(scope.nodes.map((n) => n.id)).toEqual(['parent', 'focus', 'child', 'incoming']);
    expect(scope.distances.get('focus')).toBe(0);
    expect(scope.distances.get('incoming')).toBe(1);
    expect(scope.links).toEqual([link('incoming', 'focus'), link('focus', 'focus')]);
    expect(focusGraph(nodes, links, 'focus', 2).distances.get('distant')).toBe(2);
    expect(focusGraph(nodes, links, 'missing', 5).nodes).toEqual([]);
  });
  it('places the selected item at the centre and more distant connections on outer rings', () => {
    const scene = representationScene(nodes, links, 'focused', 'focus', 2);
    const byId = new Map(scene.layout.nodes.map((n) => [n.id, n]));
    const root = byId.get('focus');
    const near = byId.get('incoming');
    const far = byId.get('distant');
    expect(root).toBeDefined();
    expect(near).toBeDefined();
    expect(far).toBeDefined();
    if (!root || !near || !far) return;
    expect(Math.hypot(far.x - root.x, far.y - root.y)).toBeGreaterThan(
      Math.hypot(near.x - root.x, near.y - root.y),
    );
    expect(scene.nodeDescriptions.get('distant')).toContain('2 connection steps');
  });
});

it('positions hierarchy parents above children and keeps sibling branches separate', () => {
  const scene = representationScene(
    [node('root'), node('a', 'root'), node('b', 'root'), node('leaf', 'a')],
    [link('leaf', 'b')],
    'hierarchy',
  );
  const byId = new Map(scene.layout.nodes.map((n) => [n.id, n]));
  expect(byId.get('root')?.y).toBeLessThan(byId.get('a')?.y ?? 0);
  expect(byId.get('a')?.y).toBeLessThan(byId.get('leaf')?.y ?? 0);
  expect(byId.get('a')?.x).not.toBe(byId.get('b')?.x);
  expect(scene.layout.referenceEdges).toHaveLength(1);
});

it('finds strongly linked communities across a weak bridge, without grouping shared parents', () => {
  const nodes = ['a', 'b', 'c', 'd', 'e', 'f', 'isolated'].map((id) => node(id, 'missing-parent'));
  const links = [
    link('a', 'b', 5),
    link('b', 'c', 5),
    link('c', 'a', 5),
    link('d', 'e', 5),
    link('e', 'f', 5),
    link('f', 'd', 5),
    link('c', 'd'),
    link('isolated', 'isolated'),
    link('missing', 'a'),
  ];
  expect(connectionGroups(nodes, links)).toEqual([['a', 'b', 'c'], ['d', 'e', 'f'], ['isolated']]);
  const scene = representationScene(nodes, links, 'clusters');
  expect(scene.decorations).toHaveLength(3);
  expect(scene.nodeDescriptions.get('isolated')).toContain('No references to other items');
});

it('uses proportional creation times and avoids overlap when dates are identical', () => {
  const nodes = [
    node('root', null, 1),
    node('middle', 'root', 2),
    node('same', 'root', 2),
    node('end', 'root', 5),
    { ...node('unknown'), createdAt: 'invalid' },
  ];
  const scene = representationScene(nodes, [], 'chronological');
  const byId = new Map(scene.layout.nodes.map((n) => [n.id, n]));
  const start = byId.get('root');
  const middle = byId.get('middle');
  const same = byId.get('same');
  const end = byId.get('end');
  expect(start).toBeDefined();
  expect(middle).toBeDefined();
  expect(same).toBeDefined();
  expect(end).toBeDefined();
  if (!start || !middle || !same || !end) return;
  expect((middle.x - start.x) / (end.x - start.x)).toBeCloseTo(0.25);
  expect(middle.x).toBe(same.x);
  expect(middle.y).not.toBe(same.y);
  expect(scene.nodeDescriptions.get('unknown')).toBe('Creation time unavailable');
  expect(scene.decorations.filter((d) => d.kind === 'time')).toHaveLength(3);
});

it.each(modes)('handles missing parents, cycles and an empty payload in %s', (mode) => {
  expect(representationScene([], [], mode).layout.nodes).toHaveLength(0);
  const nodes = [node('a', 'b'), node('b', 'a'), node('c', 'missing')];
  const scene = representationScene(nodes, [link('a', 'b'), link('b', 'missing')], mode, 'a', 5);
  for (const n of scene.layout.nodes) {
    expect(Number.isFinite(n.x)).toBe(true);
    expect(Number.isFinite(n.y)).toBe(true);
  }
  expect(scene.layout.referenceEdges.every((e) => e.targetId !== 'missing')).toBe(true);
});

it.each(modes)('fits the 2,000-item ceiling and stays deterministic in %s', (mode) => {
  const nodes = Array.from({ length: 2000 }, (_, i) =>
    node(String(i), i === 0 ? null : '0', 1 + (i % 28)),
  );
  const links = nodes.flatMap((n, i) => [
    link(n.id, String((i + 1) % 2000)),
    link(n.id, String((i + 2) % 2000)),
  ]);
  const scene = representationScene(nodes, links, mode, '0', 1);
  expect(scene.layout.nodes).toHaveLength(2000);
  const camera = fitCamera(scene.layout, { width: 360, height: 560 });
  expect(scene.layout.width * camera.scale).toBeLessThanOrEqual(360.0001);
  expect(scene.layout.height * camera.scale).toBeLessThanOrEqual(560.0001);
  expect(representationScene(nodes, links, mode, '0', 1)).toEqual(scene);
});

it('fits a hierarchy at the maximum depth', () => {
  const nodes = Array.from({ length: 2000 }, (_, i) =>
    node(String(i), i === 0 ? null : String(i - 1)),
  );
  const scene = representationScene(nodes, [], 'hierarchy');
  expect(scene.layout.nodes).toHaveLength(2000);
  const camera = fitCamera(scene.layout, { width: 360, height: 560 });
  expect(scene.layout.height * camera.scale).toBeLessThanOrEqual(560);
});
