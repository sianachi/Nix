import { describe, expect, it } from 'vitest';

import {
  boundsOf,
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
});
