/**
 * Where a caret- or selection-anchored menu should sit, kept inside the viewport.
 *
 * The slash menu, the `[[` reference picker and the bubble menu's colour picker each open at a
 * fixed left edge, always on the same side of the caret, at a fixed width - which is fine on a
 * desktop screen with room to spare in every direction. On a phone the caret sits just above the
 * on-screen keyboard, so "always below, always 280px wide" routinely opens a menu that runs off
 * the bottom or the side of the visible viewport, or under the keyboard entirely.
 *
 * Pure by design. Each call site reads its own anchor rectangle off the editor (`coordsAtPos`)
 * and the live viewport, then hands both to `placeFloatingMenu` - so the geometry that decides
 * where a menu lands is tested once, here, without a DOM or a running editor.
 */

/** The visible region a menu has to fit inside, in viewport coordinates. */
export interface FloatingMenuViewport {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** The caret's or selection's rectangle, in viewport coordinates. */
export interface FloatingMenuAnchor {
  readonly left: number;
  /** Its top edge - where an "above" menu's bottom edge lines up. */
  readonly top: number;
  /** Its bottom edge - where a "below" menu's top edge lines up. */
  readonly bottom: number;
}

export interface FloatingMenuOptions {
  /** Open above the anchor rather than below it, when there is room. Default `false`. */
  readonly preferAbove?: boolean;
  /**
   * Always open below, regardless of room above. Set on pointer-coarse for the colour menu,
   * which otherwise opens above the selection - directly under iOS's Copy/Paste bar.
   */
  readonly forceBelow?: boolean;
  /** Below this many pixels of room, the preferred side is abandoned for the other one. */
  readonly minHeight?: number;
  /** Clear kept between the menu and the viewport's edges. */
  readonly margin?: number;
}

export interface FloatingMenuPlacement {
  readonly left: number;
  /**
   * The edge to anchor the menu's own edge against: `anchor.top` when `above` is true, so the
   * menu's *bottom* should line up with it (pair with a `-translate-y-full`, as the bubble menu
   * already does); `anchor.bottom` otherwise, so the menu's *top* lines up with it directly.
   */
  readonly top: number;
  readonly above: boolean;
  /** The width to render the menu at, in pixels - already the smaller of what was asked for and what fits. */
  readonly maxWidth: number;
  /** The height to cap the menu at, in pixels, given where it landed. */
  readonly maxHeight: number;
}

const DEFAULT_MARGIN = 8;
/** Below this many pixels of room, a menu gives up its preferred side for the other one. */
const DEFAULT_MIN_HEIGHT = 120;

/**
 * The current viewport, preferring `visualViewport` - which shrinks when the on-screen keyboard
 * opens - over `innerWidth`/`innerHeight`, which do not.
 */
export function readViewportBounds(): FloatingMenuViewport {
  if (typeof window === 'undefined') {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
  const viewport = window.visualViewport;
  if (viewport) {
    return {
      left: viewport.offsetLeft,
      top: viewport.offsetTop,
      width: viewport.width,
      height: viewport.height,
    };
  }
  return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
}

/** Whether the primary pointer is coarse - touch or a stylus, rather than a mouse. */
export function isPointerCoarse(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches
  );
}

/**
 * Clamps a menu's left edge inside the viewport, caps its width to what fits, and picks which
 * side of the anchor it opens on.
 */
export function placeFloatingMenu(
  anchor: FloatingMenuAnchor,
  preferredWidth: number,
  viewport: FloatingMenuViewport,
  options: FloatingMenuOptions = {},
): FloatingMenuPlacement {
  const margin = options.margin ?? DEFAULT_MARGIN;
  const minHeight = options.minHeight ?? DEFAULT_MIN_HEIGHT;
  const preferAbove = options.preferAbove === true;
  const forceBelow = options.forceBelow === true;

  const innerLeft = viewport.left + margin;
  const innerRight = viewport.left + viewport.width - margin;
  const innerTop = viewport.top + margin;
  const innerBottom = viewport.top + viewport.height - margin;

  const maxWidth = Math.max(0, innerRight - innerLeft);
  const width = Math.min(preferredWidth, maxWidth);

  let left = anchor.left;
  if (left + width > innerRight) left = innerRight - width;
  if (left < innerLeft) left = innerLeft;

  const spaceAbove = Math.max(0, anchor.top - innerTop);
  const spaceBelow = Math.max(0, innerBottom - anchor.bottom);
  const preferredSpace = preferAbove ? spaceAbove : spaceBelow;

  // Stay on the preferred side when it has room; otherwise take the other one. `forceBelow`
  // skips the question entirely - the colour menu on a touch screen never opens above.
  const above = !forceBelow && (preferredSpace < minHeight ? !preferAbove : preferAbove);

  return {
    left,
    top: above ? anchor.top : anchor.bottom,
    above,
    maxWidth: width,
    maxHeight: Math.max(0, above ? spaceAbove : spaceBelow),
  };
}
