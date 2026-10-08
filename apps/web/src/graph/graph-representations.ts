import type { GraphLink, GraphNode } from '@nix/api-client';

import { buildAdjacency } from './graph-emphasis';
import { buildEdges, layoutGraph, nodeTitle, type GraphLayout } from './graph-layout';

export type GraphRepresentation = 'radial' | 'focused' | 'hierarchy' | 'clusters' | 'chronological';

export const GRAPH_REPRESENTATIONS: Readonly<Record<GraphRepresentation, string>> = {
  radial: 'Radial graph',
  focused: 'Focused graph',
  hierarchy: 'Hierarchy tree',
  clusters: 'Connection clusters',
  chronological: 'Chronological graph',
};

export interface GraphDecoration {
  readonly kind: 'group' | 'time' | 'lane';
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly anchor?: 'start' | 'middle' | 'end';
  readonly nodeIds?: readonly string[];
}

export interface GraphScene {
  readonly layout: GraphLayout;
  readonly links: readonly GraphLink[];
  readonly decorations: readonly GraphDecoration[];
  readonly nodeDescriptions: ReadonlyMap<string, string>;
  readonly description: string;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

/** Reuses node semantics and directed edges while changing only their positions. */
function reposition(
  base: GraphLayout,
  links: readonly GraphLink[],
  points: ReadonlyMap<string, Point>,
  decorations: readonly GraphDecoration[] = [],
): Pick<GraphScene, 'layout' | 'decorations'> {
  if (base.nodes.length === 0) return { layout: base, decorations: [] };
  const positioned = base.nodes.map((node) => ({ ...node, ...points.get(node.id) }));
  const minX = Math.min(...positioned.map((node) => node.x), ...decorations.map((d) => d.x));
  const minY = Math.min(...positioned.map((node) => node.y), ...decorations.map((d) => d.y));
  const maxX = Math.max(
    ...positioned.map((node) => node.x),
    ...decorations.map((d) => d.x + d.width),
  );
  const maxY = Math.max(
    ...positioned.map((node) => node.y),
    ...decorations.map((d) => d.y + d.height),
  );
  const dx = 64 - minX;
  const dy = 64 - minY;
  const nodes = positioned.map((node) => ({ ...node, x: node.x + dx, y: node.y + dy }));
  return {
    layout: {
      nodes,
      ...buildEdges(nodes, links),
      width: maxX - minX + 128,
      height: maxY - minY + 128,
    },
    decorations: decorations.map((d) => ({ ...d, x: d.x + dx, y: d.y + dy })),
  };
}

/** Breadth first, in both directions, over containment and references in the loaded payload. */
export function focusGraph(
  nodes: readonly GraphNode[],
  links: readonly GraphLink[],
  focusId: string | null,
  distance: number,
): {
  nodes: readonly GraphNode[];
  links: readonly GraphLink[];
  distances: ReadonlyMap<string, number>;
} {
  if (focusId === null || !nodes.some((node) => node.id === focusId))
    return { nodes: [], links: [], distances: new Map() };
  const adjacency = buildAdjacency(nodes, links);
  const distances = new Map<string, number>([[focusId, 0]]);
  const queue = [focusId];
  const bound = Math.min(5, Math.max(1, Math.floor(distance) || 1));
  // The array iterator visits newly appended neighbours without quadratic shifts.
  for (const id of queue) {
    const depth = distances.get(id) ?? 0;
    if (depth >= bound) continue;
    for (const neighbour of adjacency.get(id) ?? []) {
      if (distances.has(neighbour)) continue;
      distances.set(neighbour, depth + 1);
      queue.push(neighbour);
    }
  }
  return {
    nodes: nodes
      .filter((node) => distances.has(node.id))
      .map((node) => ({
        ...node,
        parentId: node.parentId !== null && distances.has(node.parentId) ? node.parentId : null,
      })),
    links: links.filter((link) => distances.has(link.sourceId) && distances.has(link.targetId)),
    distances,
  };
}

/** Bounded local modularity moves, using weighted references rather than a shared parent. */
export function connectionGroups(
  nodes: readonly GraphNode[],
  links: readonly GraphLink[],
): readonly (readonly string[])[] {
  const neighbours = new Map(nodes.map((node) => [node.id, new Map<string, number>()]));
  for (const link of links) {
    if (link.sourceId === link.targetId) continue;
    const source = neighbours.get(link.sourceId);
    const target = neighbours.get(link.targetId);
    if (source === undefined || target === undefined) continue;
    const weight = Math.max(1, Math.min(1_000_000, Number(link.occurrences) || 1));
    source.set(link.targetId, (source.get(link.targetId) ?? 0) + weight);
    target.set(link.sourceId, (target.get(link.sourceId) ?? 0) + weight);
  }
  const degrees = new Map(
    [...neighbours].map(([id, edges]) => [id, [...edges.values()].reduce((a, b) => a + b, 0)]),
  );
  const total = [...degrees.values()].reduce((a, b) => a + b, 0);
  const community = new Map(nodes.map((node) => [node.id, node.id]));
  const totals = new Map(degrees);
  // Each pass visits the reference adjacency once. A fixed ceiling keeps large workspaces bounded.
  for (let pass = 0; pass < 16 && total > 0; pass++) {
    let changed = false;
    for (const node of nodes) {
      const degree = degrees.get(node.id) ?? 0;
      if (degree === 0) continue;
      const old = community.get(node.id) ?? node.id;
      totals.set(old, (totals.get(old) ?? 0) - degree);
      const weights = new Map<string, number>();
      for (const [neighbour, weight] of neighbours.get(node.id) ?? []) {
        const group = community.get(neighbour) ?? neighbour;
        weights.set(group, (weights.get(group) ?? 0) + weight);
      }
      const score = (group: string): number =>
        (weights.get(group) ?? 0) - (degree * (totals.get(group) ?? 0)) / total;
      let best = old;
      let bestScore = score(old);
      for (const group of weights.keys()) {
        const next = score(group);
        if (next > bestScore + 1e-9) {
          best = group;
          bestScore = next;
        }
      }
      totals.set(best, (totals.get(best) ?? 0) + degree);
      community.set(node.id, best);
      changed ||= best !== old;
    }
    if (!changed) break;
  }
  const groups = new Map<string, string[]>();
  const isolated: string[] = [];
  for (const node of nodes) {
    if ((degrees.get(node.id) ?? 0) === 0) {
      isolated.push(node.id);
      continue;
    }
    const group = community.get(node.id) ?? node.id;
    const members = groups.get(group) ?? [];
    members.push(node.id);
    groups.set(group, members);
  }
  return [...groups.values(), ...(isolated.length === 0 ? [] : [isolated])];
}

interface Slot {
  readonly available: number;
  readonly row: number;
}
function pushSlot(heap: Slot[], slot: Slot): void {
  heap.push(slot);
  let at = heap.length - 1;
  while (at > 0) {
    const parent = Math.floor((at - 1) / 2);
    if ((heap[parent]?.available ?? Infinity) <= slot.available) break;
    const parentSlot = heap[parent];
    if (parentSlot === undefined) break;
    heap[at] = parentSlot;
    at = parent;
  }
  heap[at] = slot;
}
function popSlot(heap: Slot[]): Slot | undefined {
  const first = heap[0];
  const last = heap.pop();
  if (heap.length === 0 || last === undefined) return first;
  let at = 0;
  while (at * 2 + 1 < heap.length) {
    let child = at * 2 + 1;
    if ((heap[child + 1]?.available ?? Infinity) < (heap[child]?.available ?? Infinity)) child++;
    if (last.available <= (heap[child]?.available ?? Infinity)) break;
    const childSlot = heap[child];
    if (childSlot === undefined) break;
    heap[at] = childSlot;
    at = child;
  }
  heap[at] = last;
  return first;
}

export function representationScene(
  nodes: readonly GraphNode[],
  links: readonly GraphLink[],
  representation: GraphRepresentation,
  focusId: string | null = null,
  distance = 1,
): GraphScene {
  const scope =
    representation === 'focused' ? focusGraph(nodes, links, focusId, distance) : { nodes, links };
  const base = layoutGraph(scope.nodes, scope.links);
  const points = new Map<string, Point>();
  const descriptions = new Map<string, string>();
  const decorations: GraphDecoration[] = [];
  let description = '';
  if (representation === 'radial' || base.nodes.length === 0) {
    return {
      layout: base,
      links: scope.links,
      decorations,
      nodeDescriptions: descriptions,
      description: representation === 'focused' ? 'Choose an item to explore its connections.' : '',
    };
  }
  if (representation === 'focused' && 'distances' in scope) {
    const rings = new Map<number, string[]>();
    for (const node of base.nodes) {
      const depth = scope.distances.get(node.id) ?? 0;
      const ring = rings.get(depth) ?? [];
      ring.push(node.id);
      rings.set(depth, ring);
      descriptions.set(
        node.id,
        depth === 0 ? 'Focus item' : `${String(depth)} connection steps from the focus item`,
      );
    }
    let radius = 0;
    for (const [depth, ids] of [...rings].sort(([a], [b]) => a - b)) {
      radius = depth === 0 ? 0 : Math.max(radius + 140, (ids.length * 60) / (Math.PI * 2));
      ids.forEach((id, index) => {
        const angle = (index / ids.length) * Math.PI * 2 - Math.PI / 2;
        points.set(id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
      });
    }
    const root = nodes.find((node) => node.id === focusId);
    description = `${String(base.nodes.length)} of ${String(nodes.length)} loaded items within ${String(distance)} connection ${distance === 1 ? 'step' : 'steps'} of ${nodeTitle(root ?? { title: null })}.`;
  } else if (representation === 'hierarchy') {
    const children = new Map<string, string[]>();
    const byId = new Map(base.nodes.map((node) => [node.id, node]));
    for (const node of base.nodes) {
      if (node.parentId === null || (byId.get(node.parentId)?.depth ?? Infinity) >= node.depth)
        continue;
      const kids = children.get(node.parentId) ?? [];
      kids.push(node.id);
      children.set(node.parentId, kids);
    }
    let leaf = base.nodes.length;
    for (const node of [...base.nodes].reverse()) {
      const kids = (children.get(node.id) ?? [])
        .map((id) => points.get(id))
        .filter((point) => point !== undefined);
      const x = kids.length === 0 ? leaf-- * 160 : ((kids[0]?.x ?? 0) + (kids.at(-1)?.x ?? 0)) / 2;
      points.set(node.id, { x, y: node.depth * 110 });
    }
    description = 'Parents above children. Branches can be folded to simplify the tree.';
  } else if (representation === 'clusters') {
    const byId = new Map(base.nodes.map((node) => [node.id, node]));
    const connected = new Set(
      scope.links
        .filter((link) => link.sourceId !== link.targetId)
        .flatMap((link) => [link.sourceId, link.targetId]),
    );
    const groups = connectionGroups(scope.nodes, scope.links).map((members) =>
      [...members].sort(
        (a, b) => (byId.get(b)?.degree ?? 0) - (byId.get(a)?.degree ?? 0) || a.localeCompare(b),
      ),
    );
    const sizes = groups.map((group) => {
      const columns = Math.ceil(Math.sqrt(group.length));
      return {
        columns,
        width: Math.max(240, columns * 64 + 80),
        height: Math.ceil(group.length / columns) * 64 + 80,
      };
    });
    const shelf = Math.max(
      1200,
      ...sizes.map((size) => size.width),
      Math.sqrt(sizes.reduce((sum, size) => sum + size.width * size.height, 0)) * 1.3,
    );
    let x = 0;
    let y = 0;
    let rowHeight = 0;
    groups.forEach((group, index) => {
      const size = sizes[index];
      if (size === undefined) return;
      if (x > 0 && x + size.width > shelf) {
        x = 0;
        y += rowHeight + 80;
        rowHeight = 0;
      }
      const leader = byId.get(group[0] ?? '');
      const label = group.some((id) => connected.has(id))
        ? `${nodeTitle(leader ?? { title: null })} connections`
        : 'No references to other items';
      decorations.push({
        kind: 'group',
        label,
        x,
        y,
        width: size.width,
        height: size.height,
        nodeIds: group,
      });
      group.forEach((id, at) => {
        points.set(id, {
          x: x + 40 + (at % size.columns) * 64,
          y: y + 64 + Math.floor(at / size.columns) * 64,
        });
        descriptions.set(id, `Connection group: ${label}`);
      });
      x += size.width + 80;
      rowHeight = Math.max(rowHeight, size.height);
    });
    description = `${String(groups.length)} connection ${groups.length === 1 ? 'group' : 'groups'}, based on references between items. Shared parents do not determine groups.`;
  } else {
    const valid = base.nodes.filter((node) => Number.isFinite(Date.parse(node.createdAt)));
    const times = valid.map((node) => Date.parse(node.createdAt));
    const earliest = Math.min(...times);
    const latest = Math.max(...times);
    const width = Math.min(12000, Math.max(1000, valid.length * 40));
    const timeX = (time: number): number =>
      220 + (earliest === latest ? width / 2 : ((time - earliest) / (latest - earliest)) * width);
    const date = (time: number): string =>
      new Date(time).toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        ...(latest - earliest < 86400000 ? { hour: '2-digit', minute: '2-digit' } : {}),
      });
    if (valid.length > 0) {
      for (let tick = 0; tick < (earliest === latest ? 1 : 3); tick++) {
        const time = earliest + ((latest - earliest) * tick) / 2;
        decorations.push({
          kind: 'time',
          label: date(time),
          x: timeX(time),
          y: 0,
          width: 0,
          height: 24,
          anchor:
            earliest === latest ? 'middle' : tick === 0 ? 'start' : tick === 2 ? 'end' : 'middle',
        });
      }
    }
    const roots = new Map<string, string>();
    const lanes = new Map<string, (typeof base.nodes)[number][]>();
    for (const node of base.nodes) {
      const root = node.parentId === null ? node.id : (roots.get(node.parentId) ?? node.id);
      roots.set(node.id, root);
      const key = Number.isFinite(Date.parse(node.createdAt)) ? root : '$unknown';
      const lane = lanes.get(key) ?? [];
      lane.push(node);
      lanes.set(key, lane);
      descriptions.set(
        node.id,
        Number.isFinite(Date.parse(node.createdAt))
          ? `Created ${new Date(node.createdAt).toLocaleString()}`
          : 'Creation time unavailable',
      );
    }
    let y = 72;
    for (const [root, lane] of lanes) {
      const label =
        root === '$unknown'
          ? 'Creation time unavailable'
          : nodeTitle(base.nodes.find((node) => node.id === root) ?? { title: null });
      decorations.push({ kind: 'lane', label, x: 0, y, width: 180, height: 24 });
      const heap: Slot[] = [];
      let rows = 0;
      for (const node of [...lane].sort(
        (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id),
      )) {
        const x = root === '$unknown' ? 220 : timeX(Date.parse(node.createdAt));
        const row = (heap[0]?.available ?? Infinity) <= x ? (popSlot(heap)?.row ?? rows++) : rows++;
        points.set(node.id, { x, y: y + 40 + row * 44 });
        pushSlot(heap, { available: x + 52, row });
      }
      y += rows * 44 + 72;
    }
    description =
      'Left to right by creation time, with a lane for each top-level item. Dates describe the items that exist now.';
  }
  return {
    ...reposition(base, scope.links, points, decorations),
    links: scope.links,
    nodeDescriptions: descriptions,
    description,
  };
}
