import type { LucideIcon } from 'lucide-react';
import type { ReactElement } from 'react';

import { cx } from '../lib/cx';

/**
 * The single place a Lucide icon is rendered, so the 1.5 stroke width the
 * Industry guide mandates cannot drift usage by usage.
 *
 * Accessibility contract: an icon is decorative unless it is given a `label`.
 * Decorative icons are hidden from assistive technology; labelled ones become
 * an image with an accessible name. There is no third option, so an icon can
 * never be a silently unlabelled piece of meaning.
 */

interface IconProps {
  readonly glyph: LucideIcon;
  /** Accessible name. Omit only when the icon repeats adjacent text. */
  readonly label?: string | undefined;
  readonly className?: string | undefined;
}

export function Icon({ glyph: Glyph, label, className }: IconProps): ReactElement {
  const labelled = label !== undefined;
  return (
    <Glyph
      strokeWidth={1.5}
      aria-hidden={labelled ? undefined : true}
      role={labelled ? 'img' : undefined}
      aria-label={label}
      focusable="false"
      className={cx('size-5 shrink-0', className)}
    />
  );
}
