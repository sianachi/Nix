import { nodeTitle, type PositionedNode } from './graph-layout';

/**
 * Which nodes write their name without being asked.
 *
 * Every label at once is a grey mat; none at all is a field of anonymous dots. So the names are
 * handed out in order of how much a reader is likely to want them - roots, then the most referenced
 * - and a name is written only where it does not land on one already written. Labels are drawn in
 * the drawing's own units and scale with it, so whether two overlap does not depend on zoom: the
 * answer is worked out once per layout and zooming in simply makes the chosen ones legible.
 *
 * Greedy over a grid, so it is linear in the node count, and ordered by a total order ending in
 * the identifier, so the same workspace names the same nodes every time.
 */

/** A label's width per character, in graph units, for the small text the drawing uses. */
const CHARACTER_WIDTH = 6.5;

/** A label's height, with the breathing room that keeps two lines from touching. */
const LABEL_HEIGHT = 16;

/** Labels are cut off past this many characters when sizing; a long title must not claim a ring. */
const MEASURED_CHARACTERS = 28;

/** The grid cell. About one short label wide, so a label touches only a handful of cells. */
const CELL = 96;

interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

function labelBox(node: PositionedNode): Box {
  const left = node.x + node.radius * 2;
  const width = Math.min(nodeTitle(node).length, MEASURED_CHARACTERS) * CHARACTER_WIDTH;
  return {
    left,
    right: left + width,
    top: node.y - LABEL_HEIGHT / 2,
    bottom: node.y + LABEL_HEIGHT / 2,
  };
}

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

export function pickLabels(nodes: readonly PositionedNode[]): ReadonlySet<string> {
  const ordered = [...nodes].sort(
    (a, b) =>
      Number(a.depth !== 0) - Number(b.depth !== 0) ||
      b.degree - a.degree ||
      a.depth - b.depth ||
      a.id.localeCompare(b.id),
  );

  const grid = new Map<string, Box[]>();
  const chosen = new Set<string>();

  for (const node of ordered) {
    const box = labelBox(node);
    const cells: string[] = [];
    let free = true;

    for (
      let column = Math.floor(box.left / CELL);
      column <= Math.floor(box.right / CELL);
      column++
    ) {
      for (let row = Math.floor(box.top / CELL); row <= Math.floor(box.bottom / CELL); row++) {
        const key = `${String(column)}:${String(row)}`;
        cells.push(key);
        if (free && (grid.get(key) ?? []).some((taken) => overlaps(taken, box))) {
          free = false;
        }
      }
    }

    if (!free) {
      continue;
    }

    chosen.add(node.id);
    for (const key of cells) {
      const taken = grid.get(key);
      if (taken === undefined) {
        grid.set(key, [box]);
      } else {
        taken.push(box);
      }
    }
  }

  return chosen;
}
