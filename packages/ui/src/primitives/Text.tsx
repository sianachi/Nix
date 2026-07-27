import { cva } from 'class-variance-authority';
import { createElement, type ReactNode } from 'react';

import { cn } from '../lib/cn';

/**
 * <Text> - the typography primitive. Every string the product renders goes
 * through it, so the Industry pairing (Barlow Condensed headings over Barlow
 * body) and the type scale exist in exactly one place.
 *
 * Two rules are encoded here rather than left to discipline:
 *
 * 1. Family follows role. Heading variants take `--font-heading` at the
 *    heading weight; everything else takes `--font-body`. A caller cannot
 *    pick a family.
 *
 * 2. Accent text respects contrast. The accent/ground pair is tuned to about
 *    3:1 - enough for chrome and large display type, not for body copy - so
 *    `tone="accent"` resolves to the base accent only on the display-size
 *    headings (h1-h3, at or above the 24px WCAG large-text threshold) and to
 *    `--color-accent-text` (accent-700, 5.8:1 on the ground) everywhere else.
 *    There is no way to ask for base-accent body copy.
 *
 * Sizes, line heights and tracking are written as literals because the token
 * sheet carries no type scale: it stops at families, spacing, radii and
 * elevation. This CVA map is the scale's single home; when a `--text-*`
 * namespace lands in @nix/design-tokens these move there unchanged.
 */

export type TextVariant =
  'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'body' | 'bodySmall' | 'caption' | 'kicker';

export type TextTone = 'default' | 'muted' | 'accent';

export type TextElement =
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'h5'
  | 'h6'
  | 'p'
  | 'span'
  | 'div'
  | 'figcaption'
  // Description lists: a term and its definition are text like any other, and a caller who had to
  // drop out of the component to mark one up would be marking it up wrongly.
  | 'dt'
  | 'dd'
  // A table's caption, for the same reason: it is the table's accessible name, so it has to be a
  // real <caption> child of the <table> and cannot be a styled div sitting above it.
  | 'caption';

/** Variants that clear WCAG's large-text threshold and may carry base accent. */
const DISPLAY_VARIANTS = ['h1', 'h2', 'h3'] as const satisfies readonly TextVariant[];

/** Everything at or below h4: accent here must come from the deep ramp step. */
const BODY_SIZED_VARIANTS = [
  'h4',
  'h5',
  'h6',
  'body',
  'bodySmall',
  'caption',
  'kicker',
] as const satisfies readonly TextVariant[];

// Size first, then the traits: tailwind-merge treats a font-size utility as
// also owning line-height (Tailwind's `text-lg/7` shorthand), so a `leading-*`
// written before its `text-*` would be dropped.
const heading = 'font-heading font-semibold leading-[1.12] tracking-[-0.015em]';
const body = 'font-body font-normal leading-[1.55]';

const textVariants = cva('', {
  variants: {
    variant: {
      h1: `text-[42px] ${heading}`,
      h2: `text-[32px] ${heading}`,
      h3: `text-[25px] ${heading}`,
      h4: `text-[20px] ${heading}`,
      h5: `text-[16px] ${heading}`,
      h6: `text-[13px] ${heading} tracking-[0.08em] uppercase`,
      body: `text-[15px] ${body}`,
      bodySmall: `text-[13px] ${body}`,
      caption: `text-[11px] ${body} leading-[1.4]`,
      kicker: `text-[10px] ${body} leading-[1.4] tracking-[0.1em] uppercase`,
    },
    tone: {
      default: 'text-foreground',
      // The neutral ramp, not an ink wash. The design system's own advice is
      // to prefer a ramp step over an ad-hoc color-mix, and it pays here: the
      // 55% ink the source sheet uses for muted copy lands at 3.7:1 on the
      // ground, while neutral-700 reads the same and clears AA at 5.9:1.
      muted: 'text-neutral-700',
      // Resolved by the compound variants below - never by this entry, so a
      // new variant that forgets to declare its contrast class fails loudly
      // (uncolored text) instead of quietly shipping a 3:1 accent.
      accent: '',
    },
  },
  compoundVariants: [
    { tone: 'accent', variant: [...DISPLAY_VARIANTS], class: 'text-accent' },
    { tone: 'accent', variant: [...BODY_SIZED_VARIANTS], class: 'text-accent-text' },
  ],
  defaultVariants: { variant: 'body', tone: 'default' },
});

const DEFAULT_ELEMENT: Record<TextVariant, TextElement> = {
  h1: 'h1',
  h2: 'h2',
  h3: 'h3',
  h4: 'h4',
  h5: 'h5',
  h6: 'h6',
  body: 'p',
  bodySmall: 'p',
  caption: 'figcaption',
  kicker: 'span',
};

export interface TextProps {
  variant?: TextVariant;
  tone?: TextTone;
  /**
   * Override the rendered element when the document outline demands it - a
   * page's second-level heading styled as `h1`, say. Visual weight stays with
   * `variant`; this only changes the tag.
   */
  as?: TextElement;
  id?: string;
  children?: ReactNode;
  /** Layout only - margin, width, grid placement. Never type or color. */
  className?: string;
}

export function Text({
  variant = 'body',
  tone = 'default',
  as,
  id,
  children,
  className,
}: TextProps): ReactNode {
  return createElement(
    as ?? DEFAULT_ELEMENT[variant],
    { className: cn(textVariants({ variant, tone }), className), id },
    children,
  );
}
