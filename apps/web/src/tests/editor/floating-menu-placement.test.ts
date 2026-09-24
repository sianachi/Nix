import { describe, expect, it } from 'vitest';

import {
  placeFloatingMenu,
  type FloatingMenuAnchor,
  type FloatingMenuViewport,
} from '../../editor/floating-menu-placement';

/**
 * The geometry that keeps a floating menu inside the viewport, checked without a DOM.
 *
 * A desktop-sized viewport never exercises the clamps this exists for - a caret near the middle
 * of a 1200px screen has room on every side - so every case here is built around an edge: the
 * right edge, the bottom edge, a phone viewport with the keyboard already open.
 */

const desktopViewport: FloatingMenuViewport = { left: 0, top: 0, width: 1200, height: 800 };

function anchorAt(left: number, top: number, height = 20): FloatingMenuAnchor {
  return { left, top, bottom: top + height };
}

describe('placeFloatingMenu', () => {
  it('opens at the caret, below it, at the full width asked for, when there is room', () => {
    const placement = placeFloatingMenu(anchorAt(400, 300), 280, desktopViewport);

    expect(placement.left).toBe(400);
    expect(placement.top).toBe(320);
    expect(placement.above).toBe(false);
    expect(placement.maxWidth).toBe(280);
  });

  it('clamps the left edge inside the viewport with an 8px margin', () => {
    const nearRightEdge = placeFloatingMenu(anchorAt(1150, 300), 280, desktopViewport);
    expect(nearRightEdge.left).toBe(1200 - 8 - 280);

    const nearLeftEdge = placeFloatingMenu(anchorAt(-50, 300), 280, desktopViewport);
    expect(nearLeftEdge.left).toBe(8);
  });

  it('caps the width at the viewport width minus both margins', () => {
    const narrow: FloatingMenuViewport = { left: 0, top: 0, width: 200, height: 800 };
    const placement = placeFloatingMenu(anchorAt(50, 300), 280, narrow);

    expect(placement.maxWidth).toBe(200 - 8 - 8);
  });

  it('flips above the caret when there is no room below', () => {
    const placement = placeFloatingMenu(anchorAt(400, 780), 280, desktopViewport);

    expect(placement.above).toBe(true);
    expect(placement.top).toBe(780);
  });

  it('caps the max-height to the space available on the side it lands', () => {
    const below = placeFloatingMenu(anchorAt(400, 300, 20), 280, desktopViewport);
    expect(below.maxHeight).toBe(800 - 8 - 320);

    const above = placeFloatingMenu(anchorAt(400, 780), 280, desktopViewport);
    expect(above.maxHeight).toBe(780 - 8);
  });

  it('respects a phone-sized visualViewport, not the full layout viewport', () => {
    // The keyboard has already opened: visualViewport has shrunk to the space above it, while
    // window.innerHeight would still report the layout height including the space it covers.
    const withKeyboard: FloatingMenuViewport = { left: 0, top: 0, width: 375, height: 300 };
    const placement = placeFloatingMenu(anchorAt(200, 280), 280, withKeyboard);

    expect(placement.above).toBe(true);
    expect(placement.maxWidth).toBeLessThanOrEqual(375 - 16);
  });

  it('prefers opening above by default when asked to, flipping below only when cramped', () => {
    const roomAbove = placeFloatingMenu(anchorAt(400, 300), 280, desktopViewport, {
      preferAbove: true,
    });
    expect(roomAbove.above).toBe(true);

    const noRoomAbove = placeFloatingMenu(anchorAt(400, 20), 280, desktopViewport, {
      preferAbove: true,
    });
    expect(noRoomAbove.above).toBe(false);
    expect(noRoomAbove.top).toBe(40);
  });

  it('forces the menu below even when it would otherwise prefer above', () => {
    const placement = placeFloatingMenu(anchorAt(400, 300), 280, desktopViewport, {
      preferAbove: true,
      forceBelow: true,
    });

    expect(placement.above).toBe(false);
    expect(placement.top).toBe(320);
  });
});
