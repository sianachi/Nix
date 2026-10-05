import type { GraphLink, GraphNode } from '@nix/api-client';

/**
 * The payload with some subtrees folded away.
 *
 * A workspace near the node ceiling is too much to read at once, and the deterministic layout's
 * answer to that is not a different layout but fewer nodes: fold a branch and it becomes one disc
 * with a count. Folding happens to the payload, before layout, so what is left is laid out exactly
 * as a workspace of that shape would be - the same fold always gives the same picture.
 *
 * **A reference into a folded branch is re-pointed at the fold, not dropped.** Dropping it would
 * make folding a branch look like disconnecting it, which is a wrong answer about the workspace
 * rather than a tidier view of it. Several references that end up between the same two discs are
 * merged into one, carrying their occurrences added together.
 */
export interface FoldedGraph {
  readonly nodes: readonly GraphNode[];
  readonly links: readonly GraphLink[];

  /** For each folded node that is drawn, how many descendants it is standing in for. */
  readonly hidden: ReadonlyMap<string, number>;

  /** Every node that has children in the full payload, folded or not - the ones that can fold. */
  readonly parents: ReadonlySet<string>;
}

export function foldGraph(
  nodes: readonly GraphNode[],
  links: readonly GraphLink[],
  collapsed: ReadonlySet<string>,
): FoldedGraph {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const parents = new Set<string>();
  for (const node of nodes) {
    if (node.parentId !== null && byId.has(node.parentId)) {
      parents.add(node.parentId);
    }
  }

  if (collapsed.size === 0) {
    return { nodes, links, hidden: new Map(), parents };
  }

  // Which drawn node each node is represented by: itself when it is drawn, or the outermost
  // folded ancestor when it is not. Memoised, and guarded against a parent cycle the same way the
  // layout is - a cycle makes its members their own representatives rather than recursing forever.
  const representative = new Map<string, string>();
  const visiting = new Set<string>();
  const resolve = (node: GraphNode): string => {
    const known = representative.get(node.id);
    if (known !== undefined) {
      return known;
    }

    const parent = node.parentId === null ? undefined : byId.get(node.parentId);
    let answer = node.id;
    if (parent !== undefined && !visiting.has(node.id)) {
      visiting.add(node.id);
      const above = resolve(parent);
      visiting.delete(node.id);
      if (above !== parent.id) {
        answer = above;
      } else if (collapsed.has(parent.id)) {
        answer = parent.id;
      }
    }

    representative.set(node.id, answer);
    return answer;
  };

  const hidden = new Map<string, number>();
  const drawn: GraphNode[] = [];
  for (const node of nodes) {
    const stand = resolve(node);
    if (stand === node.id) {
      drawn.push(node);
    } else {
      hidden.set(stand, (hidden.get(stand) ?? 0) + 1);
    }
  }

  const merged = new Map<string, { sourceId: string; targetId: string; occurrences: number }>();
  for (const link of links) {
    const sourceId = representative.get(link.sourceId);
    const targetId = representative.get(link.targetId);
    // A reference between two nodes inside the same fold has nothing left to join; a reference a
    // node made to itself was a loop before folding and still is.
    if (
      sourceId === undefined ||
      targetId === undefined ||
      (sourceId === targetId && link.sourceId !== link.targetId)
    ) {
      continue;
    }

    const key = `${sourceId}>${targetId}`;
    const count = Math.max(1, Number(link.occurrences) || 1);
    const known = merged.get(key);
    if (known === undefined) {
      merged.set(key, { sourceId, targetId, occurrences: count });
    } else {
      known.occurrences += count;
    }
  }

  return { nodes: drawn, links: [...merged.values()], hidden, parents };
}

/**
 * The fold that leaves only the top of the workspace showing.
 *
 * Every node with children except a lone root: folding the only root would leave one disc, which
 * is not a view of anything.
 */
export function foldEverything(nodes: readonly GraphNode[]): ReadonlySet<string> {
  const present = new Set(nodes.map((node) => node.id));
  const roots = nodes.filter((node) => node.parentId === null || !present.has(node.parentId));
  const loneRoot = roots.length === 1 ? roots[0]?.id : undefined;

  const folded = new Set<string>();
  for (const node of nodes) {
    if (node.parentId !== null && present.has(node.parentId) && node.parentId !== loneRoot) {
      folded.add(node.parentId);
    }
  }
  return folded;
}
