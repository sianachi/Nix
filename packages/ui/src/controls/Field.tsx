import { useId, type ReactElement, type ReactNode } from 'react';

import { cn } from '../lib/cn';

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
      {/* The neutral ramp rather than a translucent ink wash, here and on the hint below: at these
          sizes an ink wash falls under the 4.5:1 contrast floor, and a label nobody can read is
          not a subtle label. The Text primitive settled this the same way for the same reason. */}
      <label
        htmlFor={controlId}
        className="font-heading text-[11px] uppercase tracking-[0.08em] text-neutral-700"
      >
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
      })}

      {invalid ? (
        // role="alert" so a validation failure that appears after a submit is announced rather
        // than only drawn.
        <p id={errorId} role="alert" className="text-[12px] text-foreground">
          {error}
        </p>
      ) : hint === undefined ? null : (
        <p id={hintId} className="text-[12px] text-neutral-700">
          {hint}
        </p>
      )}
    </div>
  );
}
