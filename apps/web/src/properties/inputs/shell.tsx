import { Field, Text, cn, disabledState, focusRing } from '@nix/ui';
import { useId, type ReactElement, type ReactNode } from 'react';

import { type PropertyOwner, type PropertyDefinition } from '../../views/core/container-model';

import { type PropertyInputProps, type PropertyInputDensity } from './types';

/**
 * The select inside a table cell: no frame, because the cell has a rule under it already and a
 * box inside a box reads as a double rule rather than as a control. Kept as a local, hand-inlined
 * class string rather than the `<Select>` primitive because a table row is denser than a form and
 * the primitive has no compact variant; `any-pointer-coarse:h-(--control-lg)` gives touch rows
 * an even height and a 44px touch target, matching what the primitive gives the panel density.
 */
export const cellSelectClasses = cn(
  'min-w-0 w-full border border-transparent bg-transparent px-2 py-1 font-body text-base text-foreground',
  'any-pointer-coarse:h-(--control-lg) any-pointer-coarse:text-lg',
  focusRing,
  disabledState,
);

/**
 * The identifiers a control is handed, whichever shell wired them.
 *
 * A superset of `FieldControlProps`: the panel shell points a visible label at the control by id,
 * the cell shell has no visible label to point and names the control directly instead.
 */
export interface ControlProps {
  readonly id?: string;
  readonly 'aria-label'?: string;
  readonly 'aria-describedby': string | undefined;
  readonly 'aria-invalid': true | undefined;
  readonly tabIndex?: number;
}

/**
 * What a control at cell density is called.
 *
 * Named per row rather than per property, matching the board's per-card control exactly: a table of
 * twelve rows would otherwise offer twelve controls all called "Status", and neither a screen reader
 * user nor a test could say which one they were operating.
 */
export function controlName(
  density: PropertyInputDensity,
  item: PropertyOwner,
  property: PropertyDefinition,
): string {
  return density === 'cell' ? `${property.label} for ${item.title || 'Untitled'}` : property.label;
}

interface ValueShellProps extends PropertyInputProps {
  readonly hint?: string;
  readonly children: (control: ControlProps) => ReactElement;
}

/**
 * The label, the error and the wiring between them - or, in a cell, the absence of all three.
 *
 * The two shells exist so the eight controls below never ask which density they are at for anything
 * but their own box. Everything that differs about *surroundings* differs here, once.
 */
export function ValueShell(props: ValueShellProps): ReactNode {
  const { property, error = null, hint, density = 'panel', children } = props;

  if (density !== 'panel') {
    return <CellShell {...props} />;
  }

  return (
    <Field
      label={property.label}
      required={property.required}
      error={error}
      {...(hint === undefined ? {} : { hint })}
    >
      {children}
    </Field>
  );
}

function CellShell(props: ValueShellProps): ReactNode {
  const { item, property, error = null, hint, density = 'cell', children } = props;

  const id = useId();
  const noteId = `${id}-note`;
  const invalid = error !== null && error.length > 0;

  return (
    <div className="flex flex-col gap-1">
      {children({
        'aria-label': controlName(density, item, property),
        'aria-describedby': invalid || hint !== undefined ? noteId : undefined,
        'aria-invalid': invalid ? true : undefined,
        ...(props.tabIndex === undefined ? {} : { tabIndex: props.tabIndex }),
      })}

      {/* The refusal sits in the cell that caused it and nowhere else. A banner over the table
          would name a property and leave somebody counting rows to find which one. */}
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
