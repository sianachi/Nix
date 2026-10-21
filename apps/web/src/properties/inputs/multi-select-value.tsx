import { Button, Field, Input, Text, cn, disabledState, fieldLabel, focusRing } from '@nix/ui';
import { useState, type ReactNode } from 'react';

import { type PropertyInputProps } from './types';
import { controlName } from './shell';
import { useMultiSelectDraft } from './drafts';

export function MultiSelectValue(
  props: PropertyInputProps & { readonly custom?: boolean },
): ReactNode {
  const { item, property, onCommit, disabled = false, error = null, density = 'panel' } = props;

  const [newValue, setNewValue] = useState('');
  const raw: unknown = item.properties[property.key];
  const stored = Array.isArray(raw)
    ? raw.filter((entry): entry is string => typeof entry === 'string')
    : typeof raw === 'string' && raw.length > 0
      ? [raw]
      : [];

  const { selection, toggle } = useMultiSelectDraft(stored, onCommit);

  // Declared order, always: a checkbox list has no "Recent" group to offer, and reordering the
  // boxes themselves would move a box out from under somebody ticking several in a row.
  const options = [
    ...property.options,
    // Same reason as the select: a value the schema no longer declares is still on the item, and a
    // control that hid it would report the item as holding less than it does.
    ...selection.filter((value) => !property.options.includes(value)),
  ];

  // A fieldset rather than <Field>, which wires a label to one control by id. A group of checkboxes
  // has no single control to point at, so the group is named by its legend instead - and in a cell
  // the legend still names the group, it is simply not drawn, because the column header above it
  // says the same word.
  return (
    <fieldset disabled={disabled} className="flex flex-col gap-1 border-0 p-0">
      <legend className={density === 'cell' ? 'sr-only' : fieldLabel}>
        {controlName(density, item, property)}
        {property.required ? (
          <span aria-hidden="true" className="ml-1 text-accent-text">
            *
          </span>
        ) : null}
      </legend>

      {options.map((option) => (
        <label key={option} className="flex items-center gap-2 font-body text-base text-foreground">
          <input
            type="checkbox"
            tabIndex={props.tabIndex}
            checked={selection.includes(option)}
            className={cn(focusRing, disabledState)}
            onKeyDown={(event) => {
              // Native checkboxes reserve Space for activation, but property fields are also used
              // in grid-style editing where Enter commits the focused value. Honour both without
              // submitting an enclosing form or letting Enter fall through to the editor.
              if (event.key === 'Enter') {
                event.preventDefault();
                event.currentTarget.click();
              }
            }}
            onChange={(event) => {
              toggle(option, event.target.checked);
            }}
          />
          {option}
        </label>
      ))}

      {error === null ? null : (
        <Text variant="note" role="alert">
          {error}
        </Text>
      )}
      {props.custom ? (
        <div className="flex items-end gap-2">
          <Field label={`New value for ${property.label}`} className="min-w-0 flex-1">
            {(control) => (
              <Input
                {...control}
                value={newValue}
                onChange={(event) => {
                  setNewValue(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    if (newValue.trim() && !selection.includes(newValue.trim())) {
                      toggle(newValue.trim(), true);
                      setNewValue('');
                    }
                  }
                }}
              />
            )}
          </Field>
          <Button
            disabled={disabled || !newValue.trim() || selection.includes(newValue.trim())}
            onClick={() => {
              toggle(newValue.trim(), true);
              setNewValue('');
            }}
          >
            Add
          </Button>
        </div>
      ) : null}
    </fieldset>
  );
}
