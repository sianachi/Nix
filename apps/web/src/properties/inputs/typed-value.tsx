import { Input } from '@nix/ui';
import { useId, useState, type ReactNode } from 'react';

import { readPropertyText } from '../../views/core/container-model';

import { type PropertyInputProps } from './types';
import { ValueShell } from './shell';
import { useDraft } from './drafts';

type TypedKind = 'text' | 'url' | 'number';

export function TypedValue(
  props: PropertyInputProps & {
    readonly kind: TypedKind;
    readonly suggestions?: readonly string[];
  },
): ReactNode {
  const { item, property, onCommit, disabled = false, density = 'panel', kind } = props;

  const suggestionsId = useId();
  const stored = readPropertyText(item, property.key);
  const { draft, setDraft, sent, send } = useDraft(stored, onCommit);

  // A `type=number` box reports '' for text it cannot parse ("3e"), which would read as a
  // deliberate clear and null the stored value. The browser's own badInput flag tells them apart.
  const [invalid, setInvalid] = useState<string | null>(null);

  function commit(input: HTMLInputElement): void {
    if (kind === 'number' && input.validity.badInput) {
      setInvalid('Enter a number.');
      return;
    }

    // A blur that changed nothing is not an edit. Without this, tabbing through the panel would
    // write every property on the way past, and Enter followed by Tab would write twice.
    if (draft === sent) {
      return;
    }

    if (kind === 'number') {
      const trimmed = draft.trim();

      if (trimmed.length === 0) {
        send(draft, null);
        return;
      }

      const parsed = Number(trimmed);

      // Nothing storable. Left on screen to be corrected rather than silently cleared: the person
      // typed something, and turning it into null would discard it without saying so.
      if (!Number.isFinite(parsed)) {
        return;
      }

      send(draft, parsed);
      return;
    }

    send(draft, draft.length === 0 ? null : draft);
  }

  return (
    <ValueShell {...props} error={props.error ?? invalid}>
      {(control) => (
        <>
          <Input
            {...control}
            tabIndex={props.tabIndex}
            type={kind}
            list={props.suggestions === undefined ? undefined : suggestionsId}
            tone={density === 'cell' ? 'plain' : 'default'}
            value={draft}
            required={property.required}
            disabled={disabled}
            onChange={(event) => {
              setInvalid(null);
              setDraft(event.target.value);
            }}
            onBlur={(event) => {
              commit(event.currentTarget);
            }}
            onKeyDown={(event) => {
              // Enter is the explicit action for somebody who types and does not move on.
              if (event.key === 'Enter') {
                event.preventDefault();
                commit(event.currentTarget);
              }
            }}
          />
          {props.suggestions === undefined ? null : (
            <datalist id={suggestionsId}>
              {props.suggestions.map((value) => (
                <option key={value} value={value} />
              ))}
            </datalist>
          )}
        </>
      )}
    </ValueShell>
  );
}
