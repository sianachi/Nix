import { describe, expect, it } from 'vitest';

import { labelPlacement, labelZoomBucket, pickLabels } from '../../graph/graph-labels';
import type { PositionedNode } from '../../graph/graph-layout';

const node: PositionedNode = {
  id: 'topic',
  title: 'A topic',
  type: 'note',
  parentId: null,
  x: 700,
  y: 200,
  depth: 1,
  degree: 0,
  radius: 8,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastModifiedAt: null,
};

describe('graph label placement', () => {
  it('anchors labels on the right half inward so the drawing edge does not clip them', () => {
    expect(labelPlacement(node, 500)).toEqual({ x: 684, textAnchor: 'end' });
  });

  it('keeps labels on the left half outward from their node', () => {
    expect(labelPlacement({ ...node, x: 300 }, 500)).toEqual({ x: 316, textAnchor: 'start' });
  });

  it('checks collisions against the drawing centre when lanes add space beside nodes', () => {
    const nodes = [
      { ...node, id: 'first', x: 0 },
      { ...node, id: 'middle', x: 100 },
      { ...node, id: 'last', x: 300 },
    ];
    expect(pickLabels(nodes).has('middle')).toBe(true);
    expect(pickLabels(nodes, 50).has('middle')).toBe(false);
  });
});

describe('graph label placement by zoom', () => {
  // Nodes 40 units apart: their labels collide when zoomed out and clear each other zoomed in.
  const row = Array.from({ length: 12 }, (_, index) => ({
    ...node,
    id: `n${String(index).padStart(2, '0')}`,
    title: 'Neighbour',
    x: index * 40,
    y: 0,
  }));

  it('buckets the camera scale down to a quarter-octave step', () => {
    expect(labelZoomBucket(1)).toBe(1);
    expect(labelZoomBucket(1.5)).toBeCloseTo(2 ** 0.5);
    expect(labelZoomBucket(0.3)).toBeCloseTo(2 ** -1.75);
    expect(labelZoomBucket(3)).toBeCloseTo(2 ** 1.5);
  });

  it('fits more labels at a higher zoom', () => {
    const far = pickLabels(row, 0, 0.25).size;
    const mid = pickLabels(row, 0, 1).size;
    const near = pickLabels(row, 0, 4).size;
    expect(far).toBeLessThan(mid);
    expect(mid).toBeLessThan(near);
  });

  it('picks the same labels for the same bucket', () => {
    expect([...pickLabels(row, 0, labelZoomBucket(1.2))]).toEqual([
      ...pickLabels(row, 0, labelZoomBucket(1.25)),
    ]);
  });
});

describe('graph label room', () => {
  // A fitted focused graph at 63% (a screenshot's positions, in graph units): the two side nodes
  // sit 35 units above "Launch project", which clears its label by about 20px on screen. They
  // were skipped when the zoom was rounded down to 0.5, which closed that gap to 17px.
  const at = (id: string, title: string, x: number, y: number, degree: number): PositionedNode => ({
    ...node,
    id,
    title,
    x,
    y,
    degree,
  });
  const fitted = [
    at('project', 'Launch project', 790, 319, 5),
    at('checklist', 'Launch checklist', 570, 284, 1),
    at('competitor', 'Competitor teardown', 1008, 284, 1),
  ];

  it('names nodes that have clear room beside them at a fitted zoom', () => {
    const named = pickLabels(fitted, 790, labelZoomBucket(0.633));
    expect([...named].sort()).toEqual(['checklist', 'competitor', 'project']);
  });

  it('keeps a pinned node named and clear of every other placed label', () => {
    const crowd = [
      at('a', 'Customer interviews', 480, 460, 9),
      at('focus', 'Prototype', 520, 464, 0),
      at('far', 'Research findings', 900, 460, 1),
    ];
    const named = pickLabels(crowd, 500, 1, ['focus']);
    // "a" would print over the focus label, so it yields; "far" has room.
    expect([...named].sort()).toEqual(['far', 'focus']);
    expect([...pickLabels(crowd, 500, 1)]).toContain('a');
  });
});
