import { nodeTitle, type PositionedNode } from './graph-layout';

/**
 * Which nodes write their name without being asked.
 *
 * Every label at once is a grey mat; none at all is a field of anonymous dots. So the names are
 * handed out in order of how much a reader is likely to want them - roots, then the most referenced
 * - and a name is written only where it does not land on one already written. Labels are drawn in
 * a constant size on screen (the drawing divides the font size by the camera's zoom), so whether
 * two overlap depends on zoom: zoomed out, the same label covers more of the drawing. The check is
 * therefore made in screen pixels at a bucketed zoom (a power of two, see `labelZoomBucket`), and
 * is worked out again only when the camera crosses to another bucket. Zooming in frees room, so
 * more names appear; the bucket rounds down, so the real spacing is never tighter than the one
 * checked.
 *
 * Greedy over a grid, so it is linear in the node count, and ordered by a total order ending in
 * the identifier, so the same workspace names the same nodes every time.
 */

/** A label's width per character, in screen pixels, for the label text size (`text-base`, 13px). */
const CHARACTER_WIDTH = 7.2;

/** A label's height, with the breathing room that keeps two lines from touching. */
const LABEL_HEIGHT = 18;

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

export interface LabelPlacement {
  readonly x: number;
  readonly textAnchor: 'start' | 'end';
}

/** Place labels away from the graph's outer edge, where the SVG would otherwise clip them. */
export function labelPlacement(node: PositionedNode, centreX: number): LabelPlacement {
  const onRight = node.x > centreX;
  return {
    x: node.x + (onRight ? -node.radius * 2 : node.radius * 2),
    textAnchor: onRight ? 'end' : 'start',
  };
}

/** The zoom a camera scale is checked at: the power of two at or below it. */
export function labelZoomBucket(scale: number): number {
  return 2 ** Math.floor(Math.log2(scale));
}

/** A label's box in screen pixels at this zoom (label size is fixed on screen, positions scale). */
function labelBox(node: PositionedNode, centreX: number, zoom: number): Box {
  const placement = labelPlacement(node, centreX);
  const width = Math.min(nodeTitle(node).length, MEASURED_CHARACTERS) * CHARACTER_WIDTH;
  const x = placement.x * zoom;
  const y = node.y * zoom;
  const left = placement.textAnchor === 'end' ? x - width : x;
  return { left, right: left + width, top: y - LABEL_HEIGHT / 2, bottom: y + LABEL_HEIGHT / 2 };
}

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

export function pickLabels(
  nodes: readonly PositionedNode[],
  drawingCentreX?: number,
  zoom = 1,
): ReadonlySet<string> {
  if (nodes.length === 0) {
    return new Set();
  }

  const minX = Math.min(...nodes.map((node) => node.x));
  const maxX = Math.max(...nodes.map((node) => node.x));
  const centreX = drawingCentreX ?? (minX + maxX) / 2;
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
    const box = labelBox(node, centreX, zoom);
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
