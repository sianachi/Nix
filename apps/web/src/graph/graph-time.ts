import { nodeTitle, type PositionedNode } from './graph-layout';

/**
 * What the dates on the nodes say: how recently each was touched, the order they arrived in, and a
 * few counts worth stating in words.
 *
 * Pure, with "now" passed in. A function that read the clock itself could only be tested against
 * the day the test happened to run.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** How recently a node was modified. Discrete, so the drawing has three states and not a gradient. */
export type Recency = 'today' | 'week' | 'older';

/**
 * A node's recency bucket.
 *
 * A missing or unreadable time is `older`. Missing is not an error: the server withholds the time
 * for an item under a lock, and "no glow" is the honest drawing of "not told".
 */
export function recencyOf(lastModifiedAt: string | null, now: number): Recency {
  if (lastModifiedAt === null) {
    return 'older';
  }

  const age = now - Date.parse(lastModifiedAt);
  if (Number.isNaN(age)) {
    return 'older';
  }
  if (age < DAY_MS) {
    return 'today';
  }
  return age < DAY_MS * 7 ? 'week' : 'older';
}

/**
 * The nodes in the order they were created, oldest first.
 *
 * Ties break on the identifier so the replay is the same every time it is played.
 */
export function creationOrder(nodes: readonly PositionedNode[]): readonly PositionedNode[] {
  return [...nodes].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id),
  );
}

export interface GraphStats {
  /** The node the most references touch, or null when no node has any. */
  readonly mostConnected: {
    readonly id: string;
    readonly title: string;
    readonly degree: number;
  } | null;

  /** Nodes no reference touches. */
  readonly orphans: number;

  /** Nodes modified within the last seven days, among those whose time is not withheld. */
  readonly editedThisWeek: number;
}

export function graphStats(nodes: readonly PositionedNode[], now: number): GraphStats {
  let hub: PositionedNode | null = null;
  let orphans = 0;
  let editedThisWeek = 0;

  for (const node of nodes) {
    if (node.degree === 0) {
      orphans += 1;
    }
    if (recencyOf(node.lastModifiedAt, now) !== 'older') {
      editedThisWeek += 1;
    }
    // Strictly greater, so the first of several equally connected nodes in layout order wins and
    // the answer does not change between two reads of the same workspace.
    if (node.degree > (hub?.degree ?? 0)) {
      hub = node;
    }
  }

  return {
    mostConnected: hub === null ? null : { id: hub.id, title: nodeTitle(hub), degree: hub.degree },
    orphans,
    editedThisWeek,
  };
}
