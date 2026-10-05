import { cva } from 'class-variance-authority';
import { type ComponentPropsWithRef, type ReactNode } from 'react';

import { cn } from '../lib/cn';
import { blueprintFrame } from '../primitives/Blueprint';
import { disabledState, fieldFocus } from '../primitives/interaction';
import { type InputTone } from './Input';

/**
 * <Textarea> - a multi-line text field, drawn exactly like <Input>.
 *
 * It exists so the app stops hand-styling its own: every `<textarea>` written in place was a
 * second copy of the field's frame, focus treatment and placeholder colour, free to drift from the
 * single-line field beside it. The frame, focus, invalid and disabled treatment are `<Input>`'s,
 * and the invalid state is likewise driven by `aria-invalid`.
 *
 * The minimum height is the control scale's large step, so one line of text is never shorter than
 * an input on a touch screen. `resize` is `vertical` by default - a horizontal drag would break
 * the column the field sits in - and `none` for a field whose height the layout owns.
 *
 * `autoGrow` relies on `field-sizing: content`, which lets the box follow its content. Browsers
 * that lack it ignore the declaration and leave a fixed-height box that scrolls, which is a
 * working field rather than a broken one. Callers cap the growth with their own `max-h-*` class.
 */

const textareaVariants = cva(
  cn(
    blueprintFrame,
    'w-full bg-background px-3 py-2',
    'min-h-(--control-lg) font-body text-md text-foreground',
    'placeholder:text-muted',
    'transition-colors',
    fieldFocus,
    disabledState,
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
      resize: {
        none: 'resize-none',
        vertical: 'resize-y',
      },
      autoGrow: {
        true: '[field-sizing:content]',
        false: '',
      },
    },
    defaultVariants: { tone: 'default', resize: 'vertical', autoGrow: false },
  },
);

export type TextareaProps = Omit<ComponentPropsWithRef<'textarea'>, 'style'> & {
  tone?: InputTone;
  /** Layout only - margin, grid placement, a `max-h-*` cap. Never a restyle of the control. */
  className?: string;
  resize?: 'none' | 'vertical';
  /** Grow with the content. Forces `resize="none"`; cap it with a `max-h-*` class. */
  autoGrow?: boolean;
};

export function Textarea(props: TextareaProps): ReactNode {
  const {
    tone = 'default',
    resize = 'vertical',
    autoGrow = false,
    className,
    rows,
    ...rest
  } = props;

  return (
    <textarea
      rows={rows ?? (autoGrow ? undefined : 3)}
      className={cn(
        textareaVariants({ tone, resize: autoGrow ? 'none' : resize, autoGrow }),
        className,
      )}
      {...rest}
    />
  );
}
