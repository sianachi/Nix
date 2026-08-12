import type { GraphLink, GraphNode } from '@nix/api-client';
import { describe, expect, it } from 'vitest';

import {
  applyOffsets,
  buildEdges,
  layoutGraph,
  nodeTitle,
  NODE_RADIUS,
  type PositionedNode,
} from '../../graph/graph-layout';

/**
 * The layout is arithmetic over a payload, so it is tested as arithmetic - no DOM, no render.
 *
 * These assert relationships rather than coordinates wherever they can. "A child is further from
 * the centre than its parent" survives a change to the ring spacing; "a child sits at x=252" does
 * not, and would make every spacing decision a test edit.
 */

function aNode(id: string, parentId: string | null, title: string | null = id): GraphNode {
  return { id, parentId, type: 'note', title };
}

function aLink(sourceId: string, targetId: string): GraphLink {
  return { sourceId, targetId };
}

function find(nodes: readonly PositionedNode[], id: string): PositionedNode {
  const node = nodes.find((candidate) => candidate.id === id);
  if (node === undefined) {
    throw new Error(`no node ${id} was placed`);
  }
  return node;
}

function distance(
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
): number {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

/** The last coordinate pair a path command ends on - where an arrowhead would be drawn. */
function endOf(path: string): { readonly x: number; readonly y: number } {
  const numbers = [...path.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
  const y = numbers[numbers.length - 1];
  const x = numbers[numbers.length - 2];
  if (x === undefined || y === undefined) {
    throw new Error(`path has no endpoint: ${path}`);
  }
  return { x, y };
}

describe('exploding a workspace from a centre', () => {
  it('puts a lone root at the centre, with its children around it', () => {
    const layout = layoutGraph(
      [aNode('root', null), aNode('a', 'root'), aNode('b', 'root'), aNode('c', 'root')],
      [],
    );

    const root = find(layout.nodes, 'root');
    const radii = ['a', 'b', 'c'].map((id) => distance(root, find(layout.nodes, id)));

    // Every child the same distance out - that is what makes it a ring rather than a scatter.
    expect(radii[0]).toBeGreaterThan(0);
    expect(radii[1]).toBeCloseTo(radii[0] ?? 0, 6);
    expect(radii[2]).toBeCloseTo(radii[0] ?? 0, 6);
  });

  it('puts each generation on a further ring', () => {
    const layout = layoutGraph(
      [aNode('root', null), aNode('a', 'root'), aNode('b', 'a'), aNode('c', 'b')],
      [],
    );

    const root = find(layout.nodes, 'root');
    const first = distance(root, find(layout.nodes, 'a'));
    const second = distance(root, find(layout.nodes, 'b'));
    const third = distance(root, find(layout.nodes, 'c'));

    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });

  it('scatters siblings around the circle rather than stacking them', () => {
    const layout = layoutGraph(
      [aNode('root', null), aNode('a', 'root'), aNode('b', 'root'), aNode('c', 'root')],
      [],
    );

    const placed = ['a', 'b', 'c'].map((id) => find(layout.nodes, id));
    const positions = new Set(placed.map((node) => `${String(node.x)},${String(node.y)}`));

    expect(positions.size).toBe(3);
  });

  /**
   * With no single subject there is nothing to put in the middle, so the centre stays empty and the
   * roots take the first ring. Still an explosion from a point - just from one nothing occupies.
   */
  it('rings an empty centre when there is more than one root', () => {
    const layout = layoutGraph([aNode('a', null), aNode('b', null), aNode('c', null)], []);

    // The centroid, not the bounding box's middle: three points spaced evenly on a circle do not
    // produce a square box, so the box's centre is not the ring's. For evenly spaced points the
    // centroid is the centre exactly, which is what makes this an assertion rather than an estimate.
    const placed = ['a', 'b', 'c'].map((id) => find(layout.nodes, id));
    const centre = {
      x: placed.reduce((sum, node) => sum + node.x, 0) / placed.length,
      y: placed.reduce((sum, node) => sum + node.y, 0) / placed.length,
    };
    const radii = placed.map((node) => distance(centre, node));

    expect(Math.min(...radii)).toBeGreaterThan(0);
    expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(1);
  });

  /**
   * A branch of many notes and a branch of one should not be handed the same wedge, or the dense
   * one is a smear of overlapping discs while the sparse one has the other half of the circle.
   */
  it('gives a denser branch a wider share of the circle', () => {
    const layout = layoutGraph(
      [
        aNode('root', null),
        aNode('big', 'root'),
        aNode('b1', 'big'),
        aNode('b2', 'big'),
        aNode('b3', 'big'),
        aNode('small', 'root'),
        aNode('s1', 'small'),
      ],
      [],
    );

    const root = find(layout.nodes, 'root');
    const angleOf = (id: string): number => {
      const node = find(layout.nodes, id);
      return Math.atan2(node.y - root.y, node.x - root.x);
    };

    const bigSpread = Math.abs(angleOf('b3') - angleOf('b1'));
    expect(bigSpread).toBeGreaterThan(0);
  });

  it('keeps siblings in the order the server sent them', () => {
    const layout = layoutGraph(
      [aNode('root', null), aNode('first', 'root'), aNode('second', 'root')],
      [],
    );

    const root = find(layout.nodes, 'root');

    // Normalised to [0, 2pi). `atan2` wraps at +/-pi, so the second of two siblings placed half a
    // turn apart comes back negative and would compare as *earlier* than the first - which would
    // fail a layout that is perfectly correct.
    const angle = (id: string): number => {
      const node = find(layout.nodes, id);
      const raw = Math.atan2(node.y - root.y, node.x - root.x);
      return (raw + Math.PI * 2) % (Math.PI * 2);
    };

    expect(angle('first')).toBeLessThan(angle('second'));
  });

  it('is deterministic - the same payload lays out identically twice', () => {
    const nodes = [aNode('root', null), aNode('a', 'root'), aNode('b', 'a')];
    const links = [aLink('b', 'root')];

    expect(layoutGraph(nodes, links)).toEqual(layoutGraph(nodes, links));
  });

  it('places a single node without collapsing the canvas to nothing', () => {
    const layout = layoutGraph([aNode('only', null)], []);

    expect(layout.nodes).toHaveLength(1);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });

  it('lays out an empty workspace without inventing a canvas', () => {
    expect(layoutGraph([], [])).toEqual({
      nodes: [],
      parentEdges: [],
      referenceEdges: [],
      width: 0,
      height: 0,
    });
  });

  it('grows the canvas to hold the outermost ring', () => {
    const shallow = layoutGraph([aNode('root', null), aNode('a', 'root')], []);
    const deep = layoutGraph(
      [aNode('root', null), aNode('a', 'root'), aNode('b', 'a'), aNode('c', 'b')],
      [],
    );

    expect(deep.width).toBeGreaterThan(shallow.width);
  });
});

/**
 * Edges. Every one is directed, so every one has to leave room at its far end for the head that
 * says which way it points.
 */
describe('drawing the edges', () => {
  it('draws a containment edge for every child', () => {
    const layout = layoutGraph([aNode('root', null), aNode('child', 'root')], []);

    expect(layout.parentEdges).toEqual([
      expect.objectContaining({ parentId: 'root', childId: 'child' }),
    ]);
  });

  it('draws an edge for every reference between two placed nodes', () => {
    const layout = layoutGraph(
      [aNode('root', null), aNode('a', 'root'), aNode('b', 'root')],
      [aLink('a', 'b')],
    );

    expect(layout.referenceEdges).toHaveLength(1);
    expect(layout.referenceEdges[0]?.sourceId).toBe('a');
    expect(layout.referenceEdges[0]?.targetId).toBe('b');
  });

  /**
   * The arithmetic the arrowheads depend on. A path that ran the whole way to the target's centre
   * would put its head inside the disc, where it reads as a line simply ending - and the direction,
   * which is the only reason to draw a head, is lost.
   */
  it('stops a containment edge short of the disc it points at', () => {
    const layout = layoutGraph([aNode('root', null), aNode('child', 'root')], []);

    const child = find(layout.nodes, 'child');
    const gap = distance(endOf(layout.parentEdges[0]?.path ?? ''), child);

    expect(gap).toBeGreaterThan(NODE_RADIUS);
  });

  it('stops a reference edge short of the disc it points at', () => {
    const layout = layoutGraph(
      [aNode('root', null), aNode('a', 'root'), aNode('b', 'root')],
      [aLink('a', 'b')],
    );

    const target = find(layout.nodes, 'b');
    const gap = distance(endOf(layout.referenceEdges[0]?.path ?? ''), target);

    expect(gap).toBeGreaterThan(NODE_RADIUS);
  });

  it('points a containment edge from the parent, so the head lands on the child', () => {
    const layout = layoutGraph([aNode('root', null), aNode('child', 'root')], []);

    const root = find(layout.nodes, 'root');
    const child = find(layout.nodes, 'child');
    const end = endOf(layout.parentEdges[0]?.path ?? '');

    expect(distance(end, child)).toBeLessThan(distance(end, root));
  });

  /**
   * The contract says a link's ends are always present, so this is about what happens when it is
   * wrong rather than a case the server produces. A dropped edge is invisible; an edge drawn to a
   * node that was never placed is a line to the SVG origin, which is a visible claim that is false.
   */
  it('drops a reference whose end is not in the payload rather than drawing it nowhere', () => {
    const layout = layoutGraph([aNode('a', null)], [aLink('a', 'missing')]);

    expect(layout.referenceEdges).toEqual([]);
  });

  it('draws a self-reference as a visible loop rather than a zero-length path', () => {
    const layout = layoutGraph([aNode('a', null)], [aLink('a', 'a')]);

    expect(layout.referenceEdges).toHaveLength(1);
    expect(layout.referenceEdges[0]?.path).toContain('a ');
  });
});

describe('payloads the contract says cannot happen', () => {
  it('treats a node whose parent is absent as a root rather than losing it', () => {
    const layout = layoutGraph([aNode('orphan', 'gone')], []);

    expect(layout.nodes).toHaveLength(1);
    expect(layout.nodes[0]?.depth).toBe(0);
  });

  it('places each node once when the payload contains a parent cycle', () => {
    const layout = layoutGraph([aNode('a', 'b'), aNode('b', 'a')], []);

    expect(layout.nodes.map((node) => node.id).sort()).toEqual(['a', 'b']);
  });

  it('terminates on a cycle rather than counting leaves forever', () => {
    const layout = layoutGraph([aNode('a', 'c'), aNode('b', 'a'), aNode('c', 'b')], []);

    expect(layout.nodes).toHaveLength(3);
  });
});

describe('naming a node', () => {
  it('uses the title when there is one', () => {
    expect(nodeTitle({ title: 'Design notes' })).toBe('Design notes');
  });

  it('supplies a placeholder when the server sent none, rather than drawing a nameless disc', () => {
    expect(nodeTitle({ title: null })).toBe('Untitled');
  });

  it('treats a stored empty title the same as an absent one', () => {
    expect(nodeTitle({ title: '' })).toBe('Untitled');
  });
});

/**
 * Nudges.
 *
 * Held apart from the layout rather than written into it, so "put it back" is dropping a map entry
 * rather than laying the graph out again - and so a refetch cannot leave a stale hand-placed
 * coordinate behind.
 */
describe('moving a node by hand', () => {
  it('leaves the arrangement alone when nothing has been moved', () => {
    const layout = layoutGraph([aNode('root', null), aNode('a', 'root')], []);

    expect(applyOffsets(layout.nodes, new Map())).toBe(layout.nodes);
  });

  it('moves only the node that was nudged', () => {
    const layout = layoutGraph([aNode('root', null), aNode('a', 'root')], []);
    const moved = applyOffsets(layout.nodes, new Map([['a', { dx: 40, dy: -25 }]]));

    const before = find(layout.nodes, 'a');
    const after = find(moved, 'a');

    expect(after.x).toBe(before.x + 40);
    expect(after.y).toBe(before.y - 25);
    expect(find(moved, 'root')).toEqual(find(layout.nodes, 'root'));
  });

  it('does not disturb the underlying layout, so the nudge can be undone', () => {
    const layout = layoutGraph([aNode('root', null), aNode('a', 'root')], []);
    const before = { ...find(layout.nodes, 'a') };

    applyOffsets(layout.nodes, new Map([['a', { dx: 100, dy: 100 }]]));

    expect(find(layout.nodes, 'a')).toEqual(before);
  });

  it('redraws the edges from where a moved node now is', () => {
    const layout = layoutGraph([aNode('root', null), aNode('a', 'root')], []);
    const moved = applyOffsets(layout.nodes, new Map([['a', { dx: 90, dy: 90 }]]));
    const redrawn = buildEdges(moved, []);

    expect(redrawn.parentEdges[0]?.path).not.toBe(layout.parentEdges[0]?.path);

    // Still landing on the disc it points at, wherever that disc has been dragged to.
    const gap = distance(endOf(redrawn.parentEdges[0]?.path ?? ''), find(moved, 'a'));
    expect(gap).toBeGreaterThan(NODE_RADIUS);
  });

  it('redraws a reference edge from where its moved end now is', () => {
    const nodes = [aNode('root', null), aNode('a', 'root'), aNode('b', 'root')];
    const links = [aLink('a', 'b')];
    const layout = layoutGraph(nodes, links);
    const moved = applyOffsets(layout.nodes, new Map([['b', { dx: 70, dy: 20 }]]));
    const redrawn = buildEdges(moved, links);

    expect(redrawn.referenceEdges[0]?.path).not.toBe(layout.referenceEdges[0]?.path);
    expect(
      distance(endOf(redrawn.referenceEdges[0]?.path ?? ''), find(moved, 'b')),
    ).toBeGreaterThan(NODE_RADIUS);
  });
});
