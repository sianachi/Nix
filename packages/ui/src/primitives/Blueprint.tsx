import { type ReactNode } from 'react';

import { cn } from '../lib/cn';

/**
 * <Blueprint> - the frame every card and figure wears.
 *
 * A hairline `--color-divider` border with softened corners, over nothing: the
 * frame is a line drawing, so it never carries a surface fill.
 *
 * **It used to have four "+" registration marks straddling square corners**,
 * and they went when the corners did. A crosshair registers a corner, so on a
 * rounded one it sits beside the curve rather than on it and reads as a
 * mistake; and the marks were the single most technical-drawing thing on
 * screen, which is the opposite of what this frame is now for. Keeping them
 * while rounding everything else would have been half a change made twice. See
 * ADR-0011.
 *
 * `rounded-md` rather than a bare `rounded`: the step is chosen for the size of
 * the box it turns, and a card is a medium box. See the radius scale.
 */

/**
 * The frame itself. Exported so a control that *is* its own frame - the primary
 * button, which cannot be wrapped in a div without moving the border off the
 * focus target - wears the same grammar rather than a lookalike.
 */
export const blueprintFrame = 'relative rounded-md border border-divider';

export interface BlueprintProps {
  children?: ReactNode;
  /**
   * The element the frame is drawn on, when the document outline demands one - a framed list
   * item, say. The frame's geometry does not change; only the tag does.
   */
  as?: 'div' | 'li' | 'section' | 'article' | 'figure';
  /**
   * Layout only - margin, width, grid placement. Not a way to restyle the
   * frame: its border, corners and transparency are the component's contract.
   */
  className?: string;
}

export function Blueprint({ children, className, as: Element = 'div' }: BlueprintProps): ReactNode {
  return <Element className={cn(blueprintFrame, className)}>{children}</Element>;
}
