import type { GraphLayout } from './graph-layout';

/**
 * How far in or out the drawing is.
 *
 * Its own module for the same reason `graph-layout.ts` is one: it is arithmetic with bounds and a
 * step, and arithmetic with bounds is where off-by-one lives. Keeping it out of the component means
 * the ladder can be tested without rendering an SVG, and the component holds one number.
 *
 * **A fixed ladder rather than a multiplier.** Repeatedly multiplying by 1.2 gives 1, 1.2, 1.44,
 * 1.728 - values a reader can never return to exactly, so "back to where I was" becomes
 * unreachable and the label reads 173%. Named steps mean every position is one a person can land
 * on again, and the reset button has somewhere unambiguous to go.
 */

/**
 * The steps, smallest first.
 *
 * A quarter at the bottom because that is roughly where a large workspace fits a pane at all, and
 * three at the top because past that a disc is a blob and the labels are the only content - at
 * which point the reader wants the item, not the drawing. The middle is denser than the ends: the
 * useful range is around 1 and a doubling step there would skip the fit a reader is hunting for.
 */
const STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3] as const;

export type Zoom = (typeof STEPS)[number];

/** Where the graph opens, and where the reset control returns to. */
export const ZOOM_DEFAULT: Zoom = 1;

/**
 * The next step in, or the same value at the ceiling.
 *
 * Saturating rather than wrapping or throwing, so a caller can compare the answer to its input to
 * decide whether the control should be disabled - which is exactly what the buttons do. A version
 * that threw at the ceiling would make the ordinary end of the ladder an error path.
 */
export function zoomIn(zoom: Zoom): Zoom {
  const next = STEPS[STEPS.indexOf(zoom) + 1];
  return next ?? zoom;
}

/** The next step out, or the same value at the floor. */
export function zoomOut(zoom: Zoom): Zoom {
  const index = STEPS.indexOf(zoom);
  return index <= 0 ? zoom : (STEPS[index - 1] ?? zoom);
}

/**
 * The drawing's painted size at a zoom level.
 *
 * The `viewBox` deliberately does **not** move: holding it at the layout's own coordinates and
 * changing only the rendered width and height is what makes the SVG scale as a picture - strokes,
 * text and all - rather than revealing more empty canvas. It also keeps every coordinate the layout
 * produced valid at every zoom level, so nothing downstream has to know the zoom exists.
 */
export function atZoom(
  layout: Pick<GraphLayout, 'width' | 'height'>,
  zoom: Zoom,
): { readonly width: number; readonly height: number } {
  return { width: layout.width * zoom, height: layout.height * zoom };
}
