import { type LucideIcon } from 'lucide-react';
import { type ReactNode } from 'react';

/**
 * <Icon> - the only way a glyph enters the product.
 *
 * The Industry set is Lucide at stroke-width 1.5; a thicker stroke reads as a
 * different design system. Wrapping Lucide here means the stroke is applied
 * once and cannot drift, and the three interface sizes stay a closed set
 * instead of an ad-hoc number at each call site.
 *
 * Accessibility: an icon is decorative unless it is the only carrier of
 * meaning. Passing no `label` hides it from assistive technology (the correct
 * default beside a text label); passing one exposes it as an image with that
 * name. There is no third state, so an icon can never reach the tree
 * unnamed.
 *
 * Sizes are px because they are glyph geometry, not a themed length - the
 * token sheet carries no icon scale.
 */

export const ICON_STROKE_WIDTH = 1.5;

export type IconSize = 'sm' | 'md' | 'lg';

const ICON_PX: Record<IconSize, number> = { sm: 16, md: 20, lg: 24 };

export interface IconProps {
  /** A Lucide component, e.g. `import { Plus } from 'lucide-react'`. */
  icon: LucideIcon;
  size?: IconSize;
  /**
   * Accessible name. Omit for a decorative icon that sits next to visible
   * text; supply one when the icon alone carries the meaning.
   */
  label?: string;
  /** Layout only - margin, grid placement. Color is inherited, never set. */
  className?: string;
}

export function Icon({ icon: Glyph, size = 'md', label, className }: IconProps): ReactNode {
  const shared = {
    size: ICON_PX[size],
    strokeWidth: ICON_STROKE_WIDTH,
    className,
  };

  return label === undefined ? (
    <Glyph {...shared} aria-hidden="true" focusable="false" />
  ) : (
    <Glyph {...shared} role="img" aria-label={label} />
  );
}
