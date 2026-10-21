import { type CellRef, cellKey } from '@nix/sheet';

/** Cell geometry is a fixed 32px of runtime arithmetic, shared by rows, header and overlay. */
export const ROW_HEIGHT = 32;

/**
 * The scroller's own viewport. The pane scrolls vertically, so the grid needs a bounded height for
 * windowing to have something to window against; the `min()` keeps it inside a short window or a
 * high zoom rather than overflowing it (the calendar's `min-h-[520px]` frame is the size's
 * precedent, the direction here is inverted on purpose - a maximum, shrinking with the viewport).
 */
export const SCROLLER_HEIGHT_CLASS = 'h-[min(520px,60dvh)]';

/** What one bulk gesture is called in the notice about it. */
export type PlanVerb = 'taken' | 'filled' | 'cleared';

export function cellId(gridId: string, ref: CellRef): string {
  return `${gridId}-cell-${cellKey(ref)}`;
}
