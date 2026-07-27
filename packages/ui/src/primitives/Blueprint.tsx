import { type ReactNode } from 'react';

import { cn } from '../lib/cn';

/**
 * <Blueprint> - the wireframe frame every card, figure and primary button
 * wears in the Industry design system.
 *
 * A hairline `--color-divider` border with four "+" registration marks
 * straddling the corners, over nothing: the frame is a line drawing, so it
 * never carries a surface fill. Square corners are baked in - there is no
 * `rounded` prop, and `rounded-none` is stated explicitly so a future change
 * to a global radius default cannot soften the frame.
 *
 * The geometry of a mark (an 11px box, hairline bars crossing 5px in, pulled
 * 6px outside the frame) is pure drawing, not a themed value. The token sheet
 * now carries a type scale and a control-height scale (ADR-0008), and neither
 * applies: a registration mark is a line drawing rather than type or a control,
 * and rounding it onto either scale would move the marks off the corner they
 * register. So the lengths stay literal, here and only here, and this is the
 * one file in the library where `[Npx]` is not a defect.
 *
 * The mark's ink is `--color-foreground` at 55%, which follows the ground: on
 * the dark ground it is a light hairline on ink rather than a dark one on
 * paper, which is what the drawing wants in both.
 */

/**
 * The frame itself, without the marks. Exported so a control that *is* its own
 * frame - the primary button, which cannot be wrapped in a div without moving
 * the border off the focus target - wears the same grammar rather than a
 * lookalike.
 */
export const blueprintFrame = 'relative rounded-none border border-divider';

const MARK_BOX = 'pointer-events-none absolute size-[11px] text-foreground/55';
const MARK_STEM = 'absolute top-0 left-[5px] h-full w-px bg-current';
const MARK_BAR = 'absolute top-[5px] left-0 h-px w-full bg-current';

const MARK_CORNERS = [
  '-top-[6px] -left-[6px]',
  '-top-[6px] -right-[6px]',
  '-bottom-[6px] -left-[6px]',
  '-bottom-[6px] -right-[6px]',
] as const;

/**
 * The four corner "+" marks, as siblings inside a positioned box.
 *
 * They are drawn with real elements rather than pseudo-elements because the
 * library ships no stylesheet to hang `::before`/`::after` on. They are
 * decorative, so they are hidden from the accessibility tree and take no
 * pointer events - a mark overlapping a button must never eat its click.
 */
export function RegistrationMarks(): ReactNode {
  return MARK_CORNERS.map((corner) => (
    <span key={corner} aria-hidden="true" className={cn(MARK_BOX, corner)}>
      <span className={MARK_STEM} />
      <span className={MARK_BAR} />
    </span>
  ));
}

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
  return (
    <Element className={cn(blueprintFrame, className)}>
      {children}
      <RegistrationMarks />
    </Element>
  );
}
