import { expect, it } from 'vitest';
import { adjustDecorations, indexDecorations } from '../../graph/graph-decorations';
import { representationScene } from '../../graph/graph-representations';

const dates = { createdAt: '2026-01-01T00:00:00Z', lastModifiedAt: null };
const scene = representationScene(
  ['a', 'b', 'c', 'd'].map((id) => ({ id, title: id, parentId: null, type: 'note', ...dates })),
  [
    { sourceId: 'a', targetId: 'b', occurrences: 1 },
    { sourceId: 'c', targetId: 'd', occurrences: 1 },
  ],
  'clusters',
);
const members = indexDecorations(scene.layout.nodes, scene.decorations);

it('keeps the decoration array for an untouched or group-free scene', () => {
  expect(adjustDecorations(scene.decorations, members, new Map())).toBe(scene.decorations);
  expect(
    adjustDecorations(scene.decorations, new Map(), new Map([['a', { dx: 50, dy: 20 }]])),
  ).toBe(scene.decorations);
});

it('expands only the moved group, contains multiple nudged members and preserves the base scene', () => {
  const adjusted = adjustDecorations(
    scene.decorations,
    members,
    new Map([
      ['a', { dx: -500, dy: -100 }],
      ['b', { dx: 500, dy: 100 }],
    ]),
  );
  const group = adjusted[0];
  const original = scene.decorations[0];
  expect(group?.x).toBeLessThan(original?.x ?? 0);
  expect(group?.width).toBeGreaterThan(original?.width ?? 0);
  expect(adjusted[1]).toBe(scene.decorations[1]);
  for (const node of scene.layout.nodes.filter((n) => n.id === 'a' || n.id === 'b')) {
    const x = node.x + (node.id === 'a' ? -500 : 500);
    expect(x).toBeGreaterThan(group?.x ?? Infinity);
    expect(x).toBeLessThan((group?.x ?? 0) + (group?.width ?? 0));
  }
  expect(original?.x).toBe(64);
});

it('does not replace outlines when the nudge stays inside them or names an absent item', () => {
  expect(
    adjustDecorations(
      scene.decorations,
      members,
      new Map([
        ['a', { dx: 1, dy: 0 }],
        ['missing', { dx: 500, dy: 0 }],
      ]),
    ),
  ).toBe(scene.decorations);
});
