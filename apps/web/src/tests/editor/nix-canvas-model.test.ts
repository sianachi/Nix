import { describe, expect, it } from 'vitest';

import {
  boundsOf,
  boundedPoints,
  clampViewport,
  intersectsViewport,
  renderableElements,
  createElement,
  updateElement,
  type NixCanvasElement,
} from '../../editor/nix-canvas-model';

function element(overrides: Partial<NixCanvasElement> = {}): NixCanvasElement {
  return {
    ...createElement('rectangle', { x: 10, y: 20 }, 'z00000'),
    id: 'shape-1',
    ...overrides,
  };
}

describe('the Nix canvas model', () => {
  it('creates durable elements with a supported type and ordering metadata', () => {
    const shape = createElement('ellipse', { x: 12, y: 30 }, 'z00001');

    expect(shape).toMatchObject({ type: 'ellipse', x: 12, y: 30, index: 'z00001' });
    expect(shape.id).toEqual(expect.any(String));
    expect(shape.version).toBe(1);
    expect(shape.versionNonce).toEqual(expect.any(Number));
  });

  it('creates freehand elements as open strokes rather than filled shapes', () => {
    expect(createElement('freehand', { x: 4, y: 8 }, 'z00002')).toMatchObject({
      type: 'freehand',
      fill: 'none',
      stroke: 'foreground',
    });
  });

  it('creates an item card with an explicit empty link until an item is chosen', () => {
    expect(createElement('card', { x: 4, y: 8 }, 'z00003')).toMatchObject({
      type: 'card',
      itemId: '',
      width: 240,
      height: 120,
    });
  });

  it('increments the element version whenever an edit is made', () => {
    const original = element();
    const moved = updateElement(original, { x: 80, y: 90 });

    expect(moved).toMatchObject({ x: 80, y: 90, version: 2 });
    expect(moved.versionNonce).toEqual(expect.any(Number));
  });

  it('creates styled shapes with safe defaults and allows style changes', () => {
    const original = createElement('rectangle', { x: 0, y: 0 }, 'z00000');
    const styled = updateElement(original, { fill: 'surface', stroke: 'accent', opacity: 0.5 });

    expect(original).toMatchObject({ fill: 'accent', stroke: 'foreground', opacity: 1 });
    expect(styled).toMatchObject({ fill: 'surface', stroke: 'accent', opacity: 0.5, version: 2 });
  });

  it('calculates bounds from visible elements and ignores tombstones', () => {
    expect(
      boundsOf([
        element({ x: 10, y: 20, width: 50, height: 40 }),
        element({ id: 'deleted', x: -100, y: -100, isDeleted: true }),
        element({ id: 'second', x: 100, y: 80, width: 20, height: 30 }),
      ]),
    ).toEqual({ x: 10, y: 20, width: 110, height: 90 });
  });

  it('returns no bounds for an empty or fully deleted scene', () => {
    expect(boundsOf([])).toBeNull();
    expect(boundsOf([element({ isDeleted: true })])).toBeNull();
  });

  it('bounds freehand point density while retaining the stroke endpoints', () => {
    const points = Array.from({ length: 2_001 }, (_, index) => ({ x: index, y: index % 3 }));
    const bounded = boundedPoints(points);

    expect(bounded).toHaveLength(2_000);
    expect(bounded[0]).toEqual(points[0]);
    expect(bounded.at(-1)).toEqual(points.at(-1));
  });

  it('culls elements outside the active viewport', () => {
    const viewport = { x: 0, y: 0, width: 100, height: 100 };

    expect(intersectsViewport(element({ x: 90, y: 90, width: 20, height: 20 }), viewport)).toBe(true);
    expect(intersectsViewport(element({ x: 101, y: 0, width: 20, height: 20 }), viewport)).toBe(false);
  });

  it('keeps a panned viewport inside the canvas bounds', () => {
    expect(clampViewport({ x: -20, y: 900, width: 600, height: 400 })).toEqual({
      x: 0,
      y: 400,
      width: 600,
      height: 400,
    });
  });

  it('renders only live elements in the viewport up to the collaboration budget', () => {
    const scene = Array.from({ length: 10_001 }, (_, index) => element({ id: `shape-${String(index)}`, x: index % 100, y: Math.floor(index / 100) }));
    const rendered = renderableElements(scene, { x: 0, y: 0, width: 1200, height: 800 });

    expect(rendered).toHaveLength(10_000);
    expect(rendered.every((shape) => !shape.isDeleted)).toBe(true);
  });
});
