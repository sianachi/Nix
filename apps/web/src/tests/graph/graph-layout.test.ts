import type { GraphLink, GraphNode } from '@nix/api-client';
import { describe, expect, it } from 'vitest';

import { layoutGraph, nodeTitle } from '../../graph/graph-layout';

/**
 * The layout is arithmetic over a payload, so it is tested as arithmetic - no DOM, no render.
 *
 * These assert relationships rather than coordinates wherever they can. "A child sits right of its
 * parent" survives a change to the column width; "a child sits at x=252" does not, and would make
 * every spacing decision a test edit.
 */

function aNode(id: string, parentId: string | null, title: string | null = id): GraphNode {
  return { id, parentId, type: 'note', title };
}

function aLink(sourceId: string, targetId: string): GraphLink {
  return { sourceId, targetId };
}

describe('laying a workspace out', () => {
  it('places a child in the column right of its parent', () => {
    const layout = layoutGraph([aNode('root', null), aNode('child', 'root')], []);

    const root = layout.nodes.find((node) => node.id === 'root');
    const child = layout.nodes.find((node) => node.id === 'child');

    expect(root?.depth).toBe(0);
    expect(child?.depth).toBe(1);
    expect(child?.x).toBeGreaterThan(root?.x ?? 0);
  });

  it('centres a parent on the rows its children occupy', () => {
    const layout = layoutGraph([aNode('root', null), aNode('a', 'root'), aNode('b', 'root')], []);

    const root = layout.nodes.find((node) => node.id === 'root');
    const a = layout.nodes.find((node) => node.id === 'a');
    const b = layout.nodes.find((node) => node.id === 'b');

    expect(root?.y).toBe(((a?.y ?? 0) + (b?.y ?? 0)) / 2);
  });

  it('keeps siblings in the order the server sent them', () => {
    const layout = layoutGraph(
      [aNode('root', null), aNode('first', 'root'), aNode('second', 'root')],
      [],
    );

    const first = layout.nodes.find((node) => node.id === 'first');
    const second = layout.nodes.find((node) => node.id === 'second');

    expect(first?.y).toBeLessThan(second?.y ?? 0);
  });

  it('is deterministic - the same payload lays out identically twice', () => {
    const nodes = [aNode('root', null), aNode('a', 'root'), aNode('b', 'a')];
    const links = [aLink('b', 'root')];

    expect(layoutGraph(nodes, links)).toEqual(layoutGraph(nodes, links));
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

  it('draws a containment edge for every child', () => {
    const layout = layoutGraph([aNode('root', null), aNode('child', 'root')], []);

    expect(layout.parentEdges).toEqual([
      expect.objectContaining({ parentId: 'root', childId: 'child' }),
    ]);
  });

  /**
   * The contract says a link's ends are always present, so this is about what happens when it is
   * wrong rather than about a case the server produces. A dropped edge is invisible; an edge drawn
   * to a node that was never placed is a line to the SVG origin, which is a visible claim that is
   * false.
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

  /**
   * The contract nulls `parentId` when the parent falls outside the node ceiling, so this should
   * not arrive - but a node whose parent is absent must still be drawn. Dropping it would be a
   * blank space in a picture, with nothing to tell a reader an item is missing.
   */
  it('treats a node whose parent is absent as a root rather than losing it', () => {
    const layout = layoutGraph([aNode('orphan', 'gone')], []);

    expect(layout.nodes).toHaveLength(1);
    expect(layout.nodes[0]?.depth).toBe(0);
  });

  it('places each node once when the payload contains a parent cycle', () => {
    const layout = layoutGraph([aNode('a', 'b'), aNode('b', 'a')], []);

    expect(layout.nodes.map((node) => node.id).sort()).toEqual(['a', 'b']);
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

  it('grows the canvas to hold the deepest column', () => {
    const shallow = layoutGraph([aNode('root', null), aNode('a', 'root')], []);
    const deep = layoutGraph(
      [aNode('root', null), aNode('a', 'root'), aNode('b', 'a'), aNode('c', 'b')],
      [],
    );

    expect(deep.width).toBeGreaterThan(shallow.width);
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
