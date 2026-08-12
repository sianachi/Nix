import { describe, expect, it } from 'vitest';

import { atZoom, zoomIn, zoomOut, ZOOM_DEFAULT, type Zoom } from '../../graph/graph-zoom';

/**
 * The zoom ladder, tested as arithmetic. Bounds are the whole reason this is a module rather than
 * two lines in the component: a step that runs off either end is the defect this shape exists to
 * make impossible, and it is cheaper to assert than to render.
 */
describe('stepping the zoom', () => {
  it('starts where the reset control returns to', () => {
    expect(ZOOM_DEFAULT).toBe(1);
  });

  it('steps in and back out to the same place', () => {
    expect(zoomOut(zoomIn(ZOOM_DEFAULT))).toBe(ZOOM_DEFAULT);
  });

  /**
   * The reason the ladder is fixed rather than a multiplier. Repeated multiplication never returns
   * to a value a reader can name, so "back to where I was" stops being reachable.
   */
  it('returns to exactly the same values, not to something near them', () => {
    let zoom: Zoom = ZOOM_DEFAULT;
    for (let step = 0; step < 3; step += 1) {
      zoom = zoomIn(zoom);
    }
    for (let step = 0; step < 3; step += 1) {
      zoom = zoomOut(zoom);
    }

    expect(zoom).toBe(ZOOM_DEFAULT);
  });

  it('saturates at the ceiling rather than running past it', () => {
    let zoom: Zoom = ZOOM_DEFAULT;
    for (let step = 0; step < 20; step += 1) {
      zoom = zoomIn(zoom);
    }

    expect(zoom).toBe(3);
    expect(zoomIn(zoom)).toBe(zoom);
  });

  it('saturates at the floor rather than reaching zero or a negative scale', () => {
    let zoom: Zoom = ZOOM_DEFAULT;
    for (let step = 0; step < 20; step += 1) {
      zoom = zoomOut(zoom);
    }

    expect(zoom).toBe(0.25);
    expect(zoomOut(zoom)).toBe(zoom);
    expect(zoom).toBeGreaterThan(0);
  });

  it('is monotonic - every step in is larger and every step out is smaller', () => {
    let zoom: Zoom = 0.25;
    while (zoomIn(zoom) !== zoom) {
      const next = zoomIn(zoom);
      expect(next).toBeGreaterThan(zoom);
      zoom = next;
    }
  });
});

describe('sizing the drawing', () => {
  it('paints at the layout size when it has not been zoomed', () => {
    expect(atZoom({ width: 800, height: 400 }, ZOOM_DEFAULT)).toEqual({ width: 800, height: 400 });
  });

  it('scales both axes together, so the drawing keeps its proportions', () => {
    expect(atZoom({ width: 800, height: 400 }, 2)).toEqual({ width: 1600, height: 800 });
  });

  it('shrinks below the layout size when zoomed out', () => {
    expect(atZoom({ width: 800, height: 400 }, 0.5)).toEqual({ width: 400, height: 200 });
  });

  it('has nothing to paint for an empty workspace at any zoom', () => {
    expect(atZoom({ width: 0, height: 0 }, 3)).toEqual({ width: 0, height: 0 });
  });
});
