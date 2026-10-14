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

  it('buckets the camera scale down to a power of two', () => {
    expect(labelZoomBucket(1)).toBe(1);
    expect(labelZoomBucket(1.9)).toBe(1);
    expect(labelZoomBucket(0.3)).toBe(0.25);
    expect(labelZoomBucket(3)).toBe(2);
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
      ...pickLabels(row, 0, labelZoomBucket(1.9)),
    ]);
  });
});
