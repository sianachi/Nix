import { cva } from 'class-variance-authority';
import { type ComponentPropsWithRef, type ReactNode } from 'react';

import { cn } from '../lib/cn';
import { RegistrationMarks, blueprintFrame } from '../primitives/Blueprint';
import {
  accentFillStates,
  accentWashStates,
  disabledState,
  focusRing,
  inkWashStates,
} from '../primitives/interaction';

/**
 * <Button> - the action control, in the four shapes the Industry system
 * defines.
 *
 * - `primary`   the one solid accent object on the board. It is the only
 *               filled button, and it keeps the blueprint registration marks.
 * - `secondary` a hairline outlined box on the ground.
 * - `ghost`     type only, no box, for tertiary actions.
 * - `icon`      a square outlined box holding a single glyph.
 *
 * Square corners are baked into the base (`rounded-none`); there is no size or
 * radius prop to soften them. Interaction states come from
 * `primitives/interaction` so hover, pressed, focus and disabled read the same
 * on every control in the library.
 *
 * Contrast, and why `primary` fills with accent-700 rather than the base
 * accent: the base accent is tuned to about 3:1 against the light ground, and
 * that ceiling is a property of the fill, not of the label - even pure white
 * on `--color-accent` reaches only 4.1:1, under the 4.5:1 AA floor for a 14px
 * label. `--color-accent-700` carries paper-colored text at 5.8:1, so it is
 * the shallowest step of the accent ramp that can hold a button label at all.
 * The button is still the one solid accent object; it just sits at the ramp
 * step the design system already reserves for accent-carrying-text. Hover and
 * pressed therefore step deeper (800, 900) instead of lighter.
 *
 * The frame is drawn by the button element itself rather than by a
 * <Blueprint> wrapper: a wrapping div would put the border and the marks
 * outside the focus target, so the focus ring and the frame would disagree.
 * Both halves still come from the frame primitive - `blueprintFrame` for the
 * hairline square box and `RegistrationMarks` for the corners - so there is
 * exactly one definition of the grammar, not a lookalike.
 *
 * The 14px label and the 36px icon-button box are literals because the token
 * sheet carries no type scale and no control-height scale; padding, gap and
 * every color resolve through the tokens.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'icon';

/**
 * The boxed variants' padding: one spacing step vertically, 1.2 steps of the
 * third step horizontally, exactly as the design system's `.btn` writes it.
 * Both are derived from `--spacing`, so a change of density moves them.
 */
const boxPadding = 'py-2 px-[calc(var(--spacing)*3.6)]';

const buttonVariants = cva(
  cn(
    blueprintFrame,
    'inline-flex cursor-pointer items-center justify-center gap-2',
    'font-heading text-[14px] leading-[1.2] font-semibold no-underline',
    'transition-colors',
    focusRing,
    disabledState,
  ),
  {
    variants: {
      variant: {
        primary: cn(
          `border-accent-700 bg-accent-700 text-background ${boxPadding}`,
          accentFillStates,
        ),
        secondary: cn(`border-divider text-foreground ${boxPadding}`, inkWashStates),
        ghost: cn('text-accent-text border-transparent py-2 px-1', accentWashStates),
        icon: cn('border-divider text-foreground size-[36px] p-0', inkWashStates),
      },
      fullWidth: {
        true: 'w-full',
        false: '',
      },
    },
    defaultVariants: { variant: 'primary', fullWidth: false },
  },
);

type ButtonBaseProps = Omit<ComponentPropsWithRef<'button'>, 'style'> & {
  /** Stretch to the container's width - the design system's block button. */
  fullWidth?: boolean;
  /** Layout only - margin, grid placement. Never a restyle of the control. */
  className?: string;
};

/**
 * An icon button has no visible text, so its accessible name has to come from
 * `aria-label`. Making that a type error rather than an axe finding is the
 * whole point of encoding the variant in the type.
 */
export type ButtonProps =
  | (ButtonBaseProps & { variant?: 'primary' | 'secondary' | 'ghost' })
  | (ButtonBaseProps & { variant: 'icon'; 'aria-label': string });

export function Button(props: ButtonProps): ReactNode {
  const {
    variant = 'primary',
    fullWidth = false,
    className,
    children,
    type = 'button',
    ...rest
  } = props;

  return (
    <button type={type} className={cn(buttonVariants({ variant, fullWidth }), className)} {...rest}>
      {children}
      {variant === 'primary' ? <RegistrationMarks /> : null}
    </button>
  );
}
