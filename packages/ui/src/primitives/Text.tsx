import { cva } from 'class-variance-authority';
import { createElement, type ReactNode } from 'react';

import { cn } from '../lib/cn';

/**
 * <Text> - the typography primitive. Every string the product renders goes
 * through it, so the pairing - one family, headings told apart by weight - and
 * the type scale exist in exactly one place.
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
 *    headings and to `--color-accent-text` everywhere else. There is no way to
 *    ask for base-accent body copy. `--color-accent-text` is a role, so it
 *    moves with the ground: accent-700 at 5.8:1 on paper, accent-300 at 12.1:1
 *    on ink.
 *
 * Sizes and line heights come from the token sheet's type scale (`--text-2xs`
 * ... `--text-3xl`, ADR-0008): each variant names a step and takes the line
 * height paired with it, and nothing here names a pixel. A body-sized heading
 * (h5, h6) therefore takes a body line height, because the pairing belongs to
 * the step rather than to the role - which is what stops the sheet and this
 * file from drifting into two scales.
 *
 * Tracking is still written as a literal: the sheet carries no tracking scale,
 * and one value per variant is not a scale worth inventing.
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

/**
 * Variants that clear WCAG's large-text threshold and may carry base accent.
 *
 * Two of them now, not three. The threshold is 24px, or 18.66px at weight 700,
 * and these headings are set at 600 - so the 24px line is the one that applies.
 * On the type scale h1 is 40px and h2 is 28px, both clear; h3 is 22px and does
 * not. It used to be 25px, which is the single visible consequence of moving
 * off hand-picked sizes, and it moves h3 to the accent step that carries body
 * copy rather than leaving it at 3.7:1.
 */
const DISPLAY_VARIANTS = ['h1', 'h2'] as const satisfies readonly TextVariant[];

/** Everything at or below h3: accent here must come from the text-carrying step. */
const BODY_SIZED_VARIANTS = [
  'h3',
  'h4',
  'h5',
  'h6',
  'body',
  'bodySmall',
  'caption',
  'kicker',
] as const satisfies readonly TextVariant[];

// Size first, then the traits: the step's paired line height is applied by the
// font-size utility, and a variant that refines the shared traits (h6's
// tracking) has to come after the constant it refines for tailwind-merge to
// keep the refinement.
const heading = 'font-heading font-semibold tracking-[-0.015em]';
const body = 'font-body font-normal';

const textVariants = cva('', {
  variants: {
    variant: {
      h1: `text-3xl ${heading}`,
      h2: `text-2xl ${heading}`,
      h3: `text-xl ${heading}`,
      h4: `text-lg ${heading}`,
      h5: `text-md ${heading}`,
      h6: `text-base ${heading} tracking-[0.08em] uppercase`,
      body: `text-md ${body}`,
      bodySmall: `text-base ${body}`,
      caption: `text-xs ${body}`,
      kicker: `text-2xs ${body} tracking-[0.1em] uppercase`,
    },
    tone: {
      default: 'text-foreground',
      // The role, not a ramp step. The design system's own advice is to prefer
      // a ramp step over an ad-hoc color-mix, and it pays here: the 55% ink the
      // source sheet uses for muted copy lands at 3.7:1 on paper. But the step
      // that reads as quiet-but-legible differs by ground - neutral-700 clears
      // AA at 5.9:1 on paper and is nearly invisible on ink - so the choice of
      // step belongs to the sheet, which is what `--color-muted` is. It crosses
      // to neutral-400 on the dark ground, 8.9:1.
      muted: 'text-muted',
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
