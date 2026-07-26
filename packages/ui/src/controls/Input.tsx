import { cva } from 'class-variance-authority';
import { type ComponentPropsWithRef, type ReactNode } from 'react';

import { cn } from '../lib/cn';
import { blueprintFrame } from '../primitives/Blueprint';
import { disabledState, focusRing } from '../primitives/interaction';

/**
 * <Input> - a single-line text field drawn as a hairline blueprint box.
 *
 * Square corners and a hairline frame, like every other box in the system, and the same
 * `:focus-visible` accent ring every control carries. There is deliberately no `size` prop: a
 * field that can be small is a field that will be small somewhere it should not be, and the
 * density of the whole system already moves with `--spacing`.
 *
 * **No registration marks.** The corner marks are the design's way of saying "this is a figure" -
 * a card, a diagram, the primary action. A text field is furniture, not a figure, and marking
 * every one of them would spend the emphasis that makes the primary button read as primary.
 *
 * The invalid state is driven by `aria-invalid` rather than a prop, so the thing a screen reader
 * announces and the thing a sighted person sees cannot drift apart: there is one source for both.
 */

const inputVariants = cva(
  cn(
    blueprintFrame,
    'w-full bg-background px-3 py-2',
    'font-body text-[14px] leading-[1.4] text-foreground',
    'placeholder:text-foreground/45',
    'transition-colors',
    focusRing,
    disabledState,
    // Invalid is drawn with the palette that exists: the divider hairline is ink at 16%, so a
    // full-strength ink frame is plainly a different state without inventing a colour. The token
    // sheet carries no status ramp, and adding one is a design decision for the token sheet rather
    // than something a control should settle by reaching for a hex.
    'aria-invalid:border-foreground',
  ),
  {
    variants: {
      tone: {
        default: 'border-divider',
        // For a field inside an already-framed surface, where a second hairline would read as a
        // double rule.
        plain: 'border-transparent bg-transparent',
      },
    },
    defaultVariants: { tone: 'default' },
  },
);

export type InputTone = 'default' | 'plain';

export type InputProps = Omit<ComponentPropsWithRef<'input'>, 'style' | 'size'> & {
  tone?: InputTone;
  /** Layout only - margin, grid placement. Never a restyle of the control. */
  className?: string;
};

export function Input(props: InputProps): ReactNode {
  const { tone = 'default', className, type = 'text', ...rest } = props;

  return <input type={type} className={cn(inputVariants({ tone }), className)} {...rest} />;
}
