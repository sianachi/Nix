import type { GraphLink, GraphNode } from '@nix/api-client';

/**
 * Where every node sits, worked out once from the payload.
 *
 * **Radial, and deterministic.** The workspace explodes from one point: roots on the innermost
 * ring, their children on the next, and so on outwards, with every node's angle decided by its
 * share of the circle rather than by a simulation. The obvious alternative is a force layout - the
 * constellation every note-taking application draws - and it settles somewhere different on every
 * load. That costs three things: a reader cannot build a memory of where anything is, one
 * screenshot cannot be compared to the next, and a test can assert almost nothing. Here the same
 * payload always produces the same picture, so all three come back.
 *
 * **Depth is distance from the centre; siblings share an arc.** Each leaf takes an equal slice of
 * the circle and every parent centres on the slice its descendants occupy, which is the radial form
 * of the same tidy-tree idea a left-to-right layout uses. A subtree with more leaves gets a wider
 * wedge, so a dense branch is not crushed into the same angle as a single note.
 *
 * **Every edge is directed and says so.** Containment runs parent to child, references run source
 * to target, and both stop short of the node they point at so the arrowhead lands on the rim rather
 * than under the disc. That shortening is arithmetic and lives here, not in the component - a
 * renderer that drew full-length paths would bury every head it had just defined.
 *
 * Nothing here is React, and nothing here measures the DOM. It is arithmetic over the payload, so
 * it is tested as arithmetic.
 */

/** Distance between one ring and the next. Chosen against a screen, like the rest of the geometry. */
const RING_SPACING = 130;

/** The drawing's breathing room, so the outermost ring is not flush against the viewBox. */
const PADDING = 48;

/** The radius of a node's disc. */
export const NODE_RADIUS = 7;

/**
 * How much room an arrowhead needs at the end of a path.
 *
 * Paths stop this far short of the target's rim so the head is drawn in clear space. Without it the
 * head sits inside the disc it points at, which reads as a line simply ending there - and the
 * direction, which is the whole reason for the head, is lost.
 */
const ARROW_CLEARANCE = 10;

export interface PositionedNode {
  readonly id: string;
  readonly title: string | null;
  readonly type: string;
  readonly parentId: string | null;
  readonly x: number;
  readonly y: number;

  /** How far from a root. Ring index, and what the accessible tree reports as its level. */
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

/** A node placed in polar coordinates, before the drawing is translated into positive space. */
interface Polar {
  readonly node: GraphNode;
  readonly radius: number;
  readonly angle: number;
  readonly depth: number;
}

/**
 * Children by parent, in the order the server sent them.
 *
 * Insertion order is load-bearing: the contract promises nodes arrive in the workspace's own
 * sibling order, so preserving it is what makes the ring's clockwise order agree with the sidebar's
 * top-to-bottom order.
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
 * A node is a root when it says it has no parent, and also when it names a parent that is not in
 * the payload. The contract says the second cannot happen - `parentId` is nulled when the parent
 * falls outside the node ceiling - but a layout that silently dropped such a node would leave a
 * blank space with no way for a reader to know something is missing.
 */
function rootsOf(nodes: readonly GraphNode[]): readonly GraphNode[] {
  const present = new Set(nodes.map((node) => node.id));
  return nodes.filter((node) => node.parentId === null || !present.has(node.parentId));
}

/**
 * How many leaves hang below each node.
 *
 * The weight each subtree is given when the circle is divided. Counting first, in its own pass, is
 * what lets the angular split be proportional rather than equal - a branch of forty notes and a
 * branch of one would otherwise be handed the same wedge, and the dense one would be a smear.
 *
 * The `visiting` set makes a cycle finite. `parentId` describes a tree built from a closure table
 * so one should be impossible, but "impossible" and "will not hang the browser" are different
 * claims and only one of them belongs in a renderer.
 */
function leafCounts(
  nodes: readonly GraphNode[],
  children: Map<string, GraphNode[]>,
): Map<string, number> {
  const counts = new Map<string, number>();
  const visiting = new Set<string>();

  const count = (node: GraphNode): number => {
    const known = counts.get(node.id);
    if (known !== undefined) {
      return known;
    }
    if (visiting.has(node.id)) {
      return 1;
    }

    visiting.add(node.id);
    const kids = children.get(node.id) ?? [];
    const total = kids.length === 0 ? 1 : kids.reduce((sum, kid) => sum + count(kid), 0);
    visiting.delete(node.id);

    counts.set(node.id, total);
    return total;
  };

  for (const node of nodes) {
    count(node);
  }

  return counts;
}

/**
 * Places every node on a ring.
 *
 * **A lone root sits at the centre; several roots ring an empty one.** With one root the picture is
 * "this workspace, and everything it holds radiating out", and putting that root anywhere but the
 * middle would be drawing a hole where the subject is. With several there is no single subject, so
 * the centre stays empty and the roots take the first ring - still an explosion from a point, just
 * from a point that nothing occupies.
 */
function place(
  all: readonly GraphNode[],
  roots: readonly GraphNode[],
  children: Map<string, GraphNode[]>,
  counts: Map<string, number>,
): readonly Polar[] {
  const placed: Polar[] = [];
  const visited = new Set<string>();

  const singleRoot = roots.length === 1;
  const ringOf = (depth: number): number => (singleRoot ? depth : depth + 1) * RING_SPACING;

  const walk = (node: GraphNode, depth: number, from: number, to: number): void => {
    if (visited.has(node.id)) {
      return;
    }
    visited.add(node.id);

    placed.push({ node, radius: ringOf(depth), angle: (from + to) / 2, depth });

    const kids = children.get(node.id) ?? [];
    if (kids.length === 0) {
      return;
    }

    // Each child takes the share of this wedge its own leaf count earns.
    const total = kids.reduce((sum, kid) => sum + (counts.get(kid.id) ?? 1), 0) || 1;
    let cursor = from;

    for (const kid of kids) {
      const share = ((counts.get(kid.id) ?? 1) / total) * (to - from);
      walk(kid, depth + 1, cursor, cursor + share);
      cursor += share;
    }
  };

  const totalLeaves = roots.reduce((sum, root) => sum + (counts.get(root.id) ?? 1), 0) || 1;
  let cursor = 0;

  for (const root of roots) {
    const share = ((counts.get(root.id) ?? 1) / totalLeaves) * Math.PI * 2;
    walk(root, 0, cursor, cursor + share);
    cursor += share;
  }

  // Anything no root reached - which a cycle guarantees, since each of its members names a parent
  // that is present. Drawn rather than dropped: a silent omission is a blank space nobody can see.
  for (const node of all) {
    if (!visited.has(node.id)) {
      walk(node, 0, cursor, cursor + Math.PI / 4);
      cursor += Math.PI / 4;
    }
  }

  return placed;
}

/**
 * A point short of the target, by a node's radius plus room for the head.
 *
 * Returned as an endpoint rather than a whole path so both edge kinds can share the shortening
 * without sharing a shape. Clamped to the distance available, so two nodes closer together than
 * the clearance produce a degenerate-but-valid path rather than one that doubles back on itself.
 */
function shortenedEnd(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): { readonly x: number; readonly y: number } {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const distance = Math.sqrt(dx * dx + dy * dy);

  if (distance === 0) {
    return { x: toX, y: toY };
  }

  const back = Math.min(NODE_RADIUS + ARROW_CLEARANCE, distance);
  return { x: toX - (dx / distance) * back, y: toY - (dy / distance) * back };
}

/**
 * A containment edge: a straight run outwards from parent to child.
 *
 * Straight rather than curved because in a radial layout the line is already almost radial, and a
 * curve there would compete with the reference arcs - which bow on purpose, and are the other half
 * of the pair a reader has to tell apart.
 */
function spoke(parent: PositionedNode, child: PositionedNode): string {
  const end = shortenedEnd(parent.x, parent.y, child.x, child.y);
  return `M ${String(parent.x)} ${String(parent.y)} L ${String(end.x)} ${String(end.y)}`;
}

/**
 * A reference edge, drawn as an arc that bulges away from the straight line.
 *
 * The bulge is what stops two references between the same pair from painting on top of each other,
 * and what tells a reference apart from a containment spoke at a glance. A self-reference - an item
 * whose body links to itself - still draws a visible loop rather than a zero-length path.
 */
function arc(source: PositionedNode, target: PositionedNode): string {
  if (source.id === target.id) {
    const loop = RING_SPACING / 4;
    return `M ${String(source.x)} ${String(source.y)} a ${String(loop)} ${String(loop)} 0 1 1 ${String(loop / 2)} 0`;
  }

  const midX = (source.x + target.x) / 2;
  const midY = (source.y + target.y) / 2;
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const distance = Math.sqrt(dx * dx + dy * dy) || 1;

  // Perpendicular to the straight line, a sixth of its length out. A sixth is the shallowest bow
  // that still reads as an arc rather than as a slightly thick line.
  const bow = distance / 6;
  const controlX = midX + (dy / distance) * bow;
  const controlY = midY - (dx / distance) * bow;

  // Backed off along the curve's own tangent at the target, which points from the control - not
  // from the source. Shortening along the chord instead would leave the head sitting beside the
  // curve it belongs to on any edge with a real bow.
  const end = shortenedEnd(controlX, controlY, target.x, target.y);

  return `M ${String(source.x)} ${String(source.y)} Q ${String(controlX)} ${String(controlY)}, ${String(end.x)} ${String(end.y)}`;
}

/**
 * Lays a payload out.
 *
 * Both edge lists are built only from nodes that were actually placed. The contract promises a
 * link's two ends are present, so the lookups should never miss - but a renderer that trusts that
 * and is wrong draws a path to `undefined`, which SVG renders as a line to the origin: a visible
 * edge that means nothing.
 */
export function layoutGraph(nodes: readonly GraphNode[], links: readonly GraphLink[]): GraphLayout {
  if (nodes.length === 0) {
    return { nodes: [], parentEdges: [], referenceEdges: [], width: 0, height: 0 };
  }

  const children = childrenByParent(nodes);
  const counts = leafCounts(nodes, children);
  const polar = place(nodes, rootsOf(nodes), children, counts);

  // Polar to cartesian, then translated so the whole drawing sits in positive space. The extent is
  // measured rather than assumed: a single node has radius zero, and a viewBox derived from the
  // outermost ring would collapse to nothing for it.
  const points = polar.map((entry) => ({
    entry,
    x: Math.cos(entry.angle) * entry.radius,
    y: Math.sin(entry.angle) * entry.radius,
  }));

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);

  const placed: PositionedNode[] = points.map((point) => ({
    id: point.entry.node.id,
    title: point.entry.node.title,
    type: point.entry.node.type,
    parentId: point.entry.node.parentId,
    x: point.x - minX + PADDING,
    y: point.y - minY + PADDING,
    depth: point.entry.depth,
  }));

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

    parentEdges.push({ childId: node.id, parentId: parent.id, path: spoke(parent, node) });
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

  return {
    nodes: placed,
    parentEdges,
    referenceEdges,
    width: maxX - minX + PADDING * 2,
    height: maxY - minY + PADDING * 2,
  };
}

/**
 * What an item is called, for a reader.
 *
 * The server does not invent a name for an item that has never been given one, which is correct of
 * it - a stored empty title and an absent one are different facts. A drawing still has to write
 * something beside the disc, so the placeholder is supplied here, once, in the same words the rest
 * of the application uses for the same situation.
 */
export function nodeTitle(node: { readonly title: string | null }): string {
  return node.title !== null && node.title.length > 0 ? node.title : 'Untitled';
}
