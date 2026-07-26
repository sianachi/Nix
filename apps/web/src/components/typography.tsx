import type { ReactElement, ReactNode } from 'react';

import { cx } from '../lib/cx';

/**
 * Typography primitives. Two rules from the Industry guide are encoded here so
 * no page has to remember them:
 *
 *   1. Headings are Barlow Condensed (`font-heading`), body copy is Barlow
 *      (`font-body`) - always through the token utilities, never by naming a
 *      family.
 *   2. The accent against the light ground is tuned to roughly 3:1 - enough
 *      for chrome and large type, not for paragraph text. So `tone="accent"`
 *      on body-size text resolves to `text-accent-text`, which the token sheet
 *      aliases to accent-700.
 *
 * The type scale itself is not a design token (the Industry sheet carries no
 * modular scale), so heading sizes use Tailwind's default text steps.
 */

type HeadingLevel = 1 | 2 | 3 | 4;

interface HeadingProps {
  readonly level: HeadingLevel;
  readonly children: ReactNode;
  readonly id?: string | undefined;
  readonly className?: string | undefined;
}

const HEADING_SIZE: Record<HeadingLevel, string> = {
  1: 'text-5xl',
  2: 'text-3xl',
  3: 'text-xl',
  4: 'text-base',
};

export function Heading({ level, children, id, className }: HeadingProps): ReactElement {
  const Element = `h${String(level)}` as 'h1' | 'h2' | 'h3' | 'h4';
  return (
    <Element
      id={id}
      className={cx(
        'font-heading font-semibold tracking-tight text-foreground uppercase',
        HEADING_SIZE[level],
        className,
      )}
    >
      {children}
    </Element>
  );
}

type TextTone = 'default' | 'muted' | 'accent';

type TextSize = 'sm' | 'xs';

interface TextProps {
  readonly children: ReactNode;
  readonly tone?: TextTone;
  readonly size?: TextSize;
  readonly as?: 'p' | 'span' | 'dd' | 'dt' | 'figcaption';
  /**
   * Layout only - margins, widths, grid placement. Tone and size are props
   * precisely so a caller never passes a colour or a size class in here and
   * ends up in a specificity race with the component's own utilities.
   */
  readonly className?: string | undefined;
}

const TEXT_TONE: Record<TextTone, string> = {
  default: 'text-foreground',
  muted: 'text-neutral-700',
  // accent-700, not the base accent: body-size accent text needs the contrast.
  accent: 'text-accent-text',
};

const TEXT_SIZE: Record<TextSize, string> = {
  sm: 'text-sm',
  xs: 'text-xs',
};

export function Text({
  children,
  tone = 'default',
  size = 'sm',
  as = 'p',
  className,
}: TextProps): ReactElement {
  const Element = as;
  return (
    <Element
      className={cx('font-body leading-relaxed', TEXT_SIZE[size], TEXT_TONE[tone], className)}
    >
      {children}
    </Element>
  );
}

/**
 * The small condensed label the Industry grammar puts above a card title and
 * alongside status values: heading family, letter-spaced, upper case.
 *
 * It is small type, so the accent tone resolves to accent-700
 * (`text-accent-text`) rather than the base accent.
 */
export function Kicker({
  children,
  tone = 'accent',
}: {
  readonly children: ReactNode;
  readonly tone?: 'accent' | 'muted';
}): ReactElement {
  return (
    <span
      className={cx(
        'font-heading text-xs tracking-widest uppercase',
        tone === 'accent' ? 'text-accent-text' : 'text-neutral-700',
      )}
    >
      {children}
    </span>
  );
}
