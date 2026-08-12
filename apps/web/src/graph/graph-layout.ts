import type { GraphLink, GraphNode } from '@nix/api-client';

/**
 * Where every node sits, worked out once from the payload.
 *
 * **Deterministic, and that is the design rather than a simplification.** The obvious alternative
 * is a force simulation - the constellation every note-taking application draws - and it settles
 * somewhere different on every load. That costs three things this codebase is not willing to pay:
 * a reader cannot build a memory of where anything is, a screenshot cannot be compared to the next
 * one, and a test can assert almost nothing about the result. Here the same payload always
 * produces the same picture, so all three come back.
 *
 * **The containment tree supplies the positions; references are drawn over them.** Every node
 * carries a `parentId`, so the workspace already has a shape, and it is the shape the reader
 * already knows from the sidebar. Using it means the graph answers "where does this live" by
 * position and "what points at what" by edge, rather than making one picture answer both badly.
 *
 * The algorithm is the layered part of Reingold-Tilford with no crossing minimisation: depth
 * decides the column, a post-order walk hands each leaf the next row, and every parent centres on
 * the rows its descendants occupy. Left-to-right rather than top-down because the labels are
 * horizontal text and a column gives them somewhere to go.
 *
 * Nothing here is React, and nothing here measures the DOM. It is arithmetic over the payload, so
 * it is tested as arithmetic.
 */

/** Horizontal distance between one depth and the next. Room for a label, chosen against a screen. */
const COLUMN_WIDTH = 220;

/** Vertical distance between two adjacent rows. */
const ROW_HEIGHT = 44;

/** The drawing's breathing room, so the outermost nodes are not flush against the viewBox. */
const PADDING = 32;

/** The radius of a node's disc. */
export const NODE_RADIUS = 7;

export interface PositionedNode {
  readonly id: string;
  readonly title: string | null;
  readonly type: string;
  readonly parentId: string | null;
  readonly x: number;
  readonly y: number;

  /** How far from a root. Column index, and also what the accessible tree reports as its level. */
  readonly depth: number;
}

/** A containment edge - this node's parent is that node. Drawn as the structure, not the point. */
export interface ParentEdge {
  readonly childId: string;
  readonly parentId: string;
  readonly path: string;
}

/** A reference edge - some text in one item points at another. The thing the graph exists to show. */
export interface ReferenceEdge {
  readonly sourceId: string;
  readonly targetId: string;
  readonly path: string;
}

export interface GraphLayout {
  readonly nodes: readonly PositionedNode[];
  readonly parentEdges: readonly ParentEdge[];
  readonly referenceEdges: readonly ReferenceEdge[];
  readonly width: number;
  readonly height: number;
}

/**
 * Children by parent, in the order the server sent them.
 *
 * Insertion order is load-bearing: the contract promises nodes arrive in the workspace's own
 * sibling order, so preserving it is what makes the graph's rows agree with the sidebar's rows.
 * A `Map` keeps it; a plain object would too, but only by accident of key type.
 */
function childrenByParent(nodes: readonly GraphNode[]): Map<string, GraphNode[]> {
  const children = new Map<string, GraphNode[]>();

  for (const node of nodes) {
    if (node.parentId === null) {
      continue;
    }

    const siblings = children.get(node.parentId);
    if (siblings === undefined) {
      children.set(node.parentId, [node]);
      continue;
    }

    siblings.push(node);
  }

  return children;
}

/**
 * The nodes that start a tree.
 *
 * A node is a root when it says it has no parent, and *also* when it names a parent that is not in
 * the payload. The contract says the second case cannot happen - `parentId` is nulled when the
 * parent falls outside the node ceiling - but a layout that silently drops a node when it does
 * would be a blank space in a drawing with no way for a reader to know something is missing.
 * Treating it as a root shows the item; the alternative loses it.
 */
function rootsOf(nodes: readonly GraphNode[]): readonly GraphNode[] {
  const present = new Set(nodes.map((node) => node.id));
  return nodes.filter((node) => node.parentId === null || !present.has(node.parentId));
}

/**
 * Positions every node, and answers how many rows were used.
 *
 * The `visited` set is not defensive decoration. `parentId` describes a tree and the server builds
 * it from a closure table, so a cycle should be impossible - but "should be impossible" and "will
 * not hang the browser" are different claims, and only one of them is worth relying on in a
 * renderer. A node reached twice is placed once.
 *
 * **Every node is placed, including ones no root reaches.** A cycle has no root by definition -
 * each of its members names a parent that is present - so walking only the roots would draw
 * nothing at all for it. Anything the root walk misses is swept in afterwards as its own root,
 * because a drawing that silently omits items is worse than one that draws a malformed payload
 * plainly: the first is a blank space nobody can see, the second is visible and reportable.
 */
function place(
  all: readonly GraphNode[],
  roots: readonly GraphNode[],
  children: Map<string, GraphNode[]>,
): { readonly placed: readonly PositionedNode[]; readonly rows: number } {
  const placed: PositionedNode[] = [];
  const visited = new Set<string>();
  let nextRow = 0;

  const walk = (node: GraphNode, depth: number): number => {
    if (visited.has(node.id)) {
      return nextRow;
    }
    visited.add(node.id);

    const kids = children.get(node.id) ?? [];
    let row: number;

    if (kids.length === 0) {
      row = nextRow;
      nextRow += 1;
    } else {
      // Post-order: the children take their rows first, then this node centres on the span they
      // ended up occupying. Centring on the first and last child rather than averaging all of them
      // is what keeps a parent visually attached to its group when the group is lopsided.
      const rows = kids.map((kid) => walk(kid, depth + 1));
      const first = rows[0];
      const last = rows[rows.length - 1];
      row = first === undefined || last === undefined ? nextRow : (first + last) / 2;
    }

    placed.push({
      id: node.id,
      title: node.title,
      type: node.type,
      parentId: node.parentId,
      x: PADDING + depth * COLUMN_WIDTH,
      y: PADDING + row * ROW_HEIGHT,
      depth,
    });

    return row;
  };

  for (const root of roots) {
    walk(root, 0);
  }

  // The sweep. Empty for every payload the contract can actually produce.
  for (const node of all) {
    walk(node, 0);
  }

  return { placed, rows: nextRow };
}

/**
 * A containment edge, drawn as an elbow.
 *
 * A straight line between two columns reads as "connected"; an elbow that leaves the parent
 * horizontally and arrives at the child horizontally reads as "contains", which is the sidebar's
 * own visual grammar and the distinction this drawing needs to carry.
 */
function elbow(parent: PositionedNode, child: PositionedNode): string {
  const midX = (parent.x + child.x) / 2;
  return `M ${String(parent.x)} ${String(parent.y)} C ${String(midX)} ${String(parent.y)}, ${String(midX)} ${String(child.y)}, ${String(child.x)} ${String(child.y)}`;
}

/**
 * A reference edge, drawn as an arc that bulges away from the straight line.
 *
 * The bulge is what stops two references between the same pair of columns from painting on top of
 * each other, and what tells a reference apart from a containment elbow at a glance. It scales
 * with the distance covered so a long edge bows more than a short one, and a self-reference - an
 * item whose body links to itself - still draws a visible loop rather than a zero-length path.
 */
function arc(source: PositionedNode, target: PositionedNode): string {
  if (source.id === target.id) {
    const loop = ROW_HEIGHT / 2;
    return `M ${String(source.x)} ${String(source.y)} a ${String(loop)} ${String(loop)} 0 1 1 ${String(loop / 2)} 0`;
  }

  const midX = (source.x + target.x) / 2;
  const midY = (source.y + target.y) / 2;
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const distance = Math.sqrt(dx * dx + dy * dy);

  // Perpendicular to the straight line, a sixth of its length out. A sixth is the shallowest bow
  // that stays visibly an arc at the row spacing above rather than reading as a slightly thick line.
  const bow = distance / 6;
  const controlX = midX + (dy / (distance || 1)) * bow;
  const controlY = midY - (dx / (distance || 1)) * bow;

  return `M ${String(source.x)} ${String(source.y)} Q ${String(controlX)} ${String(controlY)}, ${String(target.x)} ${String(target.y)}`;
}

/**
 * Lays a payload out.
 *
 * Both edge lists are built only from nodes that were actually placed. The contract already
 * promises a link's two ends are present, so the lookups below should never miss - but a renderer
 * that trusts that and is wrong draws a path to `undefined`, which SVG renders as a line to the
 * origin: a visible edge that means nothing. Checking is cheaper than that failure mode.
 */
export function layoutGraph(nodes: readonly GraphNode[], links: readonly GraphLink[]): GraphLayout {
  if (nodes.length === 0) {
    return { nodes: [], parentEdges: [], referenceEdges: [], width: 0, height: 0 };
  }

  const children = childrenByParent(nodes);
  const { placed, rows } = place(nodes, rootsOf(nodes), children);
  const byId = new Map(placed.map((node) => [node.id, node]));

  const parentEdges: ParentEdge[] = [];
  for (const node of placed) {
    if (node.parentId === null) {
      continue;
    }

    const parent = byId.get(node.parentId);
    if (parent === undefined) {
      continue;
    }

    parentEdges.push({ childId: node.id, parentId: parent.id, path: elbow(parent, node) });
  }

  const referenceEdges: ReferenceEdge[] = [];
  for (const link of links) {
    const source = byId.get(link.sourceId);
    const target = byId.get(link.targetId);
    if (source === undefined || target === undefined) {
      continue;
    }

    referenceEdges.push({
      sourceId: link.sourceId,
      targetId: link.targetId,
      path: arc(source, target),
    });
  }

  const deepest = placed.reduce((far, node) => Math.max(far, node.x), 0);

  return {
    nodes: placed,
    parentEdges,
    referenceEdges,
    width: deepest + PADDING,
    height: PADDING * 2 + Math.max(rows - 1, 0) * ROW_HEIGHT,
  };
}

/**
 * What an item is called, for a reader.
 *
 * The server does not invent a name for an item that has never been given one, which is correct of
 * it - a stored empty title and an absent one are different facts. A drawing still has to write
 * something under the disc, so the placeholder is supplied here, once, in the same words the rest
 * of the application uses for the same situation.
 */
export function nodeTitle(node: { readonly title: string | null }): string {
  return node.title !== null && node.title.length > 0 ? node.title : 'Untitled';
}
