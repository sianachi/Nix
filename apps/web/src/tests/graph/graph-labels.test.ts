import { describe, expect, it } from 'vitest';

import { labelPlacement, pickLabels } from '../../graph/graph-labels';
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
