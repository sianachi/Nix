import type { ReactElement, ReactNode } from 'react';

import { cx } from '../lib/cx';
import { Blueprint } from './blueprint';

/**
 * Actions, in the two variants this scaffold needs.
 *
 *   primary   - the one solid accent object on the board. It keeps the square
 *               corners and the registration marks, per the Industry guide.
 *               It fills with accent-700, not the base accent: a paper label
 *               on the base reaches only 4.15:1, under the 4.5:1 the floor
 *               requires, and no label colour clears it on that fill.
 *               accent-700 is the shallowest ramp step that carries a paper
 *               label (6.47:1), with hover and pressed stepping deeper. The
 *               accent-hover / accent-pressed aliases still apply where they
 *               belong, to variants sitting on the ground rather than
 *               carrying text on a fill.
 *   secondary - a transparent hairline object; accent-700 label for contrast.
 *
 * Focus is themed, never the browser default: a 2px accent outline offset by
 * 2px, on :focus-visible only. Disabled drops to 45% opacity.
 *
 * `className` is layout-only. Restyling happens by adding a variant here, not
 * by passing colour classes in from a page.
 */

type ButtonVariant = 'primary' | 'secondary';

interface ButtonProps {
  readonly children: ReactNode;
  readonly onClick: () => void;
  readonly variant?: ButtonVariant;
  readonly disabled?: boolean;
  readonly className?: string | undefined;
}

const BASE =
  'inline-flex items-center justify-center gap-2 px-5 py-2 font-heading text-sm ' +
  'font-semibold tracking-wide uppercase transition-colors ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ' +
  'disabled:pointer-events-none disabled:opacity-45';

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-accent-700 text-neutral-100 hover:bg-accent-800 active:bg-accent-900',
  secondary: 'text-accent-text hover:bg-accent-100 active:bg-accent-200',
};

export function Button({
  children,
  onClick,
  variant = 'primary',
  disabled = false,
  className,
}: ButtonProps): ReactElement {
  // Both variants are framed objects: the primary is the frame plus the accent
  // fill, the secondary is the frame alone.
  return (
    <Blueprint className={cx('inline-flex', className)}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={cx(BASE, VARIANT[variant])}
      >
        {children}
      </button>
    </Blueprint>
  );
}
