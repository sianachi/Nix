import { useEffect, useRef, type RefObject } from 'react';

import { placeFloatingMenu, readViewportBounds } from '../primitives/placement';
import type { FloatingMenuAnchor } from '../primitives/placement';

/**
 * Keeps a fixed-position panel beside its anchor and inside the visual viewport.
 *
 * Shared by `<Menu>`, `<ContextMenu>` and `<Popover>`, which all float a panel off a trigger or a
 * point and all owe the same three things: open below and flip above when there is no room, stay
 * 8px inside the *visual* viewport (which shrinks under an on-screen keyboard), and step aside on a
 * phone, where the panel is a bottom sheet laid out entirely in CSS.
 *
 * `anchor` is read on every placement rather than captured, so a caller may pass a fresh closure
 * each render without re-binding the listeners. `remeasure` re-runs placement when the panel's
 * content - and so its size - changes.
 */
export function useAnchoredPanel(
  panelRef: RefObject<HTMLElement | null>,
  anchor: () => FloatingMenuAnchor | null,
  remeasure: unknown,
): void {
  const latest = useRef(anchor);
  useEffect(() => {
    latest.current = anchor;
  });

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    const margin = 8;

    const place = (): void => {
      const desktop =
        typeof matchMedia === 'function' ? matchMedia('(min-width: 640px)').matches : true;
      if (!desktop) {
        // Below `sm`, the panel is a bottom sheet laid out entirely in CSS; an inline position
        // here would only have to be cleared again above.
        panel.style.removeProperty('top');
        panel.style.removeProperty('left');
        panel.style.removeProperty('transform');
        panel.style.removeProperty('max-height');
        return;
      }

      const anchorRect = latest.current();
      if (anchorRect === null) return;
      const panelRect = panel.getBoundingClientRect();

      // `minHeight` set to the panel's own measured height (plus the same margin) flips it
      // whenever there is not enough room below for the panel as rendered.
      const placement = placeFloatingMenu(anchorRect, panelRect.width, readViewportBounds(), {
        minHeight: panelRect.height + margin,
      });

      // A panel taller than either side of its anchor is capped to the side chosen, and its own
      // overflow-y-auto makes the rest reachable by scrolling.
      panel.style.setProperty('max-height', `${String(placement.maxHeight)}px`);
      panel.style.setProperty('left', `${String(placement.left)}px`);
      panel.style.setProperty(
        'top',
        `${String(placement.above ? placement.top - 4 : placement.top + 4)}px`,
      );
      panel.style.setProperty('transform', placement.above ? 'translateY(-100%)' : 'none');
    };

    place();
    const viewport = window.visualViewport;
    window.addEventListener('resize', place);
    viewport?.addEventListener('resize', place);
    viewport?.addEventListener('scroll', place);
    return () => {
      window.removeEventListener('resize', place);
      viewport?.removeEventListener('resize', place);
      viewport?.removeEventListener('scroll', place);
    };
  }, [panelRef, remeasure]);
}
