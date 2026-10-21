import { Field, Text } from '@nix/ui';
import { useId, type ReactElement, type ReactNode } from 'react';

/** The identifiers the shell below hands its one labelled control. */
export interface ImageControlProps {
  readonly id?: string;
  readonly 'aria-label'?: string;
  readonly 'aria-describedby': string | undefined;
  readonly 'aria-invalid': true | undefined;
}

interface ImageShellProps {
  readonly density: 'panel' | 'cell';
  readonly label: string;
  readonly name: string;
  readonly required: boolean;
  readonly error: string | null;
  readonly hint?: string;
  readonly children: (control: ImageControlProps) => ReactElement;
}

/**
 * The label, the error and the wiring between them, at either density - the same division of
 * labour as `property-input.tsx`'s shells: panel labels itself through `<Field>`, cell relies on
 * the column header and names its control after its row.
 */
export function ImageShell(props: ImageShellProps): ReactNode {
  const { density, label, name, required, error, hint, children } = props;

  const id = useId();
  const noteId = `${id}-note`;
  const invalid = error !== null && error.length > 0;

  if (density === 'panel') {
    return (
      <Field
        label={label}
        required={required}
        error={error}
        {...(hint === undefined ? {} : { hint })}
      >
        {children}
      </Field>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {children({
        'aria-label': name,
        'aria-describedby': invalid || hint !== undefined ? noteId : undefined,
        'aria-invalid': invalid ? true : undefined,
      })}

      {/* The refusal sits in the cell that caused it, exactly as the sibling shells place it. */}
      {invalid ? (
        <Text variant="note" id={noteId} role="alert">
          {error}
        </Text>
      ) : hint === undefined ? null : (
        <Text variant="note" tone="muted" id={noteId}>
          {hint}
        </Text>
      )}
    </div>
  );
}
