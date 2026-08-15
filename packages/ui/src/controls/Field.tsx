import { useId, type ReactElement, type ReactNode } from 'react';

import { cn } from '../lib/cn';
import { Text, fieldLabel } from '../primitives/Text';

/**
 * <Field> - a label, a control, and the two bits of text that belong to it.
 *
 * The reason this is a component rather than a convention is the wiring. A label needs `htmlFor`,
 * a hint and an error need `aria-describedby`, and an invalid control needs `aria-invalid` - four
 * identifiers that have to agree, hand-written at every call site, and silently wrong when they do
 * not. Here they are generated once and handed to the control through a render prop, so a field
 * cannot be assembled incorrectly.
 *
 * **The error replaces the hint rather than joining it.** Two lines of guidance under one input,
 * one of which is now wrong, is worse than one line that is right.
 */

export interface FieldControlProps {
  readonly id: string;
  readonly 'aria-describedby': string | undefined;
  readonly 'aria-invalid': true | undefined;

  /**
   * Carried into the control so required-ness reaches assistive technology, not only the label's
   * asterisk (which is aria-hidden). Provided here rather than remembered at every call site -
   * one form field shipped announcing nothing precisely because the site had to remember.
   */
  readonly required: boolean | undefined;
}

export interface FieldProps {
  /** The visible label. Always present: a placeholder is not a label. */
  readonly label: string;

  /** Guidance shown under the control while it is valid. */
  readonly hint?: string;

  /** What is wrong. Its presence is what makes the field invalid. */
  readonly error?: string | null;

  /** Marks the control required, for the label and for assistive technology alike. */
  readonly required?: boolean;

  /** Layout only. */
  readonly className?: string;

  /** Renders the control with the identifiers already wired. */
  readonly children: (props: FieldControlProps) => ReactElement;
}

export function Field(props: FieldProps): ReactNode {
  const { label, hint, error, required = false, className, children } = props;

  const id = useId();
  const controlId = `${id}-control`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  const invalid = typeof error === 'string' && error.length > 0;
  const describedBy = invalid ? errorId : hint === undefined ? undefined : hintId;

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {/* The muted role rather than a translucent ink wash, here and on the hint below: at these
          sizes an ink wash falls under the 4.5:1 contrast floor, and a label nobody can read is
          not a subtle label. A ramp step would have been the light ground's answer baked in -
          `--color-muted` is the same colour there and crosses the ramp on the dark one. The Text
          primitive settled this the same way for the same reason. */}
      <label htmlFor={controlId} className={fieldLabel}>
        {label}
        {required ? (
          <span aria-hidden="true" className="ml-1 text-accent-text">
            *
          </span>
        ) : null}
      </label>

      {children({
        id: controlId,
        'aria-describedby': describedBy,
        'aria-invalid': invalid ? true : undefined,
        required: required ? true : undefined,
      })}

      {invalid ? (
        // role="alert" so a validation failure that appears after a submit is announced rather
        // than only drawn.
        <Text variant="note" id={errorId} role="alert">
          {error}
        </Text>
      ) : hint === undefined ? null : (
        <Text variant="note" tone="muted" id={hintId}>
          {hint}
        </Text>
      )}
    </div>
  );
}
