import type { Offset, PositionedNode } from './graph-layout';
import type { GraphDecoration } from './graph-representations';

interface Member {
  readonly node: PositionedNode;
  readonly group: number;
}

/** Index membership once per scene rather than rebuilding it during a drag. */
export function indexDecorations(
  nodes: readonly PositionedNode[],
  decorations: readonly GraphDecoration[],
): ReadonlyMap<string, Member> {
  const members = new Map<string, Member>();
  if (!decorations.some((decoration) => decoration.kind === 'group')) return members;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  decorations.forEach((decoration, group) => {
    for (const id of decoration.nodeIds ?? []) {
      const node = byId.get(id);
      if (node !== undefined) members.set(id, { node, group });
    }
  });
  return members;
}

/** Only nudged members can expand a group's outline; all other marks keep their identities. */
export function adjustDecorations(
  decorations: readonly GraphDecoration[],
  members: ReadonlyMap<string, Member>,
  offsets: ReadonlyMap<string, Offset>,
): readonly GraphDecoration[] {
  if (members.size === 0 || offsets.size === 0) return decorations;
  const changed = new Map<number, GraphDecoration>();
  for (const [id, offset] of offsets) {
    if (offset.dx === 0 && offset.dy === 0) continue;
    const member = members.get(id);
    if (member === undefined) continue;
    const previous = changed.get(member.group) ?? decorations[member.group];
    if (previous === undefined) continue;
    const nodeX = member.node.x + offset.dx;
    const nodeY = member.node.y + offset.dy;
    const x = Math.min(previous.x, nodeX - 32);
    const y = Math.min(previous.y, nodeY - 56);
    const right = Math.max(previous.x + previous.width, nodeX + 32);
    const bottom = Math.max(previous.y + previous.height, nodeY + 32);
    if (
      x === previous.x &&
      y === previous.y &&
      right === previous.x + previous.width &&
      bottom === previous.y + previous.height
    )
      continue;
    changed.set(member.group, { ...previous, x, y, width: right - x, height: bottom - y });
  }
  return changed.size === 0
    ? decorations
    : decorations.map((decoration, group) => changed.get(group) ?? decoration);
}
