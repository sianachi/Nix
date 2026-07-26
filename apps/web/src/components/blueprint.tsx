import type { ReactElement, ReactNode } from 'react';

import { cx } from '../lib/cx';

/**
 * The Industry blueprint frame: a square-cornered hairline border with a "+"
 * registration mark crosshair centred on each corner.
 *
 * Grammar rules baked in rather than left to the caller:
 *   - square corners; there is no radius prop to misuse
 *   - transparent; framed objects are line drawings, so there is no fill prop
 *   - all four marks always render; a framed element never loses one
 *
 * `className` is for layout only (grid placement, margins, padding) - never
 * for restyling the frame itself.
 *
 * This is the app-local stand-in for the eventual packages/ui <Blueprint>.
 */

interface BlueprintProps {
  readonly children: ReactNode;
  readonly className?: string | undefined;
  /** Rendered element. Sections use `section`, figures use `figure`. */
  readonly as?: 'div' | 'section' | 'figure' | 'li';
}

const CORNER_OFFSETS = {
  topLeft: '-top-1 -left-1',
  topRight: '-top-1 -right-1',
  bottomLeft: '-bottom-1 -left-1',
  bottomRight: '-bottom-1 -right-1',
} as const;

function RegistrationMark({ offset }: { readonly offset: string }): ReactElement {
  // Two hairlines crossing at the centre of a spacing-2 (6.8px) box, offset by
  // half that so the crosshair sits exactly on the frame corner.
  return (
    <span aria-hidden="true" className={cx('pointer-events-none absolute size-2', offset)}>
      <span className="absolute top-1/2 left-0 h-px w-full -translate-y-1/2 bg-accent" />
      <span className="absolute top-0 left-1/2 h-full w-px -translate-x-1/2 bg-accent" />
    </span>
  );
}

export function Blueprint({ children, className, as = 'div' }: BlueprintProps): ReactElement {
  const Element = as;
  return (
    <Element className={cx('relative border border-divider', className)}>
      <RegistrationMark offset={CORNER_OFFSETS.topLeft} />
      <RegistrationMark offset={CORNER_OFFSETS.topRight} />
      <RegistrationMark offset={CORNER_OFFSETS.bottomLeft} />
      <RegistrationMark offset={CORNER_OFFSETS.bottomRight} />
      {children}
    </Element>
  );
}
