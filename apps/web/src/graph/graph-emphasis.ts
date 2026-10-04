import type { GraphLink } from '@nix/api-client';

import { nodeTitle, type PositionedNode } from './graph-layout';

/**
 * Which nodes the drawing should bring forward, and why.
 *
 * A graph past a few hundred references is a mat of arcs, and the only way to read one node's
 * connections out of it is to push everything else back. This module answers "which nodes stay
 * forward" for the two reasons a reader has: they are pointing at a node, or they have asked for a
 * kind of node. It is set arithmetic over the payload, so it is tested as that.
 */

/** Every node's neighbours, by containment and by reference, in both directions. */
export type Adjacency = ReadonlyMap<string, ReadonlySet<string>>;

export function buildAdjacency(
  nodes: readonly PositionedNode[],
  links: readonly GraphLink[],
): Adjacency {
  const adjacency = new Map<string, Set<string>>(nodes.map((node) => [node.id, new Set<string>()]));

  const join = (a: string, b: string): void => {
    const fromA = adjacency.get(a);
    const fromB = adjacency.get(b);
    // Both ends or neither: an edge into a node the payload does not carry is not drawn, so it
    // is not a neighbour either.
    if (fromA === undefined || fromB === undefined || a === b) {
      return;
    }
    fromA.add(b);
    fromB.add(a);
  };

  for (const node of nodes) {
    if (node.parentId !== null) {
      join(node.id, node.parentId);
    }
  }
  for (const link of links) {
    join(link.sourceId, link.targetId);
  }

  return adjacency;
}

/** One node and everything it touches. */
export function neighbourhood(adjacency: Adjacency, id: string): ReadonlySet<string> {
  return new Set([id, ...(adjacency.get(id) ?? [])]);
}

/** What a reader has asked the drawing to pick out. */
export interface GraphFilter {
  /** Matched against titles, case-insensitively. Empty means "no search". */
  readonly search: string;

  /** A body kind, or `null` for every kind. */
  readonly type: string | null;

  /** Only items no reference touches. */
  readonly orphansOnly: boolean;
}

export const NO_FILTER: GraphFilter = { search: '', type: null, orphansOnly: false };

export function filterIsActive(filter: GraphFilter): boolean {
  return filter.search.trim().length > 0 || filter.type !== null || filter.orphansOnly;
}

/**
 * The nodes a filter picks, in layout order.
 *
 * In layout order so "the next match" walks the drawing the same way every time. Matching dims the
 * rest rather than removing it: taking nodes out would lay the workspace out again, and a reader
 * who filtered to find something would lose where everything else was.
 */
export function matchingNodes(
  nodes: readonly PositionedNode[],
  filter: GraphFilter,
): readonly PositionedNode[] {
  const needle = filter.search.trim().toLocaleLowerCase();

  return nodes.filter(
    (node) =>
      (needle.length === 0 || nodeTitle(node).toLocaleLowerCase().includes(needle)) &&
      (filter.type === null || node.type === filter.type) &&
      (!filter.orphansOnly || node.degree === 0),
  );
}
