import { cva } from 'class-variance-authority';
import { type ComponentPropsWithRef, type ReactNode } from 'react';

import { cn } from '../lib/cn';

/**
 * <Tag> - a small square-cornered label for a state or a category.
 *
 * Type-led, like the rest of the chrome: a hairline box in condensed uppercase, never a filled
 * pill. The one solid accent object on a screen is the primary button, so a tag that filled itself
 * with accent would compete with the action the design wants read first.
 *
 * `tone` names what the tag is *for*, not what colour it is. A caller asking for `accent` is
 * saying "this is the current or selected one", which is a fact about the data; asking for a
 * colour would be a fact about this screen, and would be wrong on the next one.
 */

const tagVariants = cva(
  cn(
    'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5',
    'font-heading text-xs uppercase tracking-wider',
  ),
  {
    variants: {
      tone: {
        /** The ordinary case: a category, a type, a name. */
        neutral: 'border-divider text-foreground/70',
        /**
         * Selected, current, or otherwise the one being pointed at. Box and text are the same
         * role, so the tag is one mark; the ramp step this used to name for the box reads 2.7:1
         * on the dark ground, under the 3:1 floor a state indicator owes.
         */
        accent: 'border-accent-text text-accent-text',
        /**
         * Deliberately quiet - a detail that is present but not the point. Quiet is the muted role
         * rather than a translucent ink wash: at 11px an ink wash lands around 4:1 on the ground,
         * under the 4.5:1 floor, and "quiet" must never mean "unreadable". A role rather than the
         * ramp step behind it, because which end of the neutral ramp reads as quiet depends on
         * which ground the tag is sitting on.
         */
        muted: 'border-transparent bg-foreground/5 text-muted',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export type TagTone = 'neutral' | 'accent' | 'muted';

export type TagProps = Omit<ComponentPropsWithRef<'span'>, 'style'> & {
  tone?: TagTone;
  className?: string;
};

export function Tag(props: TagProps): ReactNode {
  const { tone = 'neutral', className, children, ...rest } = props;

  return (
    <span className={cn(tagVariants({ tone }), className)} {...rest}>
      {children}
    </span>
  );
}
