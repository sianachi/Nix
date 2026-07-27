import { Field, Input, blueprintFrame, cn, disabledState, focusRing } from '@nix/ui';
import { useState, type ReactNode } from 'react';

import {
  readDateValue,
  readPropertyText,
  readSelectValue,
  type Item,
  type PropertyDefinition,
  type PropertyValue,
} from '../views/container-model';

/**
 * One control for one property, chosen from what the schema says the property is.
 *
 * **The type is an open set, so this dispatch has to have a floor.** The contract calls a property
 * type a string rather than an enum on purpose: adding a type is a feature, not a parse failure in
 * every client that has not been rebuilt. A build that met an unfamiliar type by rendering nothing
 * would hide a value somebody stored, so the unknown case shows the value as stored, read-only, and
 * says why it cannot be edited here.
 *
 * **Nothing here writes per keystroke.** Typed values commit on blur or on Enter; the discrete ones
 * - a select, a checkbox, a date picked from the field - commit on the choice itself, because the
 * choice is the whole gesture. A control that fired a request per character would put a write
 * behind every letter of a note's owner.
 *
 * **A field always shows what the item holds.** The draft below is what somebody is part-way
 * through typing, not a second copy of the value: it is replaced whenever the stored value moves,
 * so a write the server refused leaves the field showing the value that is really there with the
 * refusal beside it, rather than a screenful of text that was never stored.
 */

export interface PropertyInputProps {
  readonly item: Item;
  readonly property: PropertyDefinition;

  /**
   * Hands over the value to store for this property. Null clears it, per the merge contract, and
   * this is called once per completed edit rather than once per keystroke.
   */
  readonly onCommit: (value: PropertyValue) => void;

  readonly disabled?: boolean;

  /** The server's reason for refusing this property's last write, shown verbatim. */
  readonly error?: string | null;
}

/** The types this build can edit. Anything else falls through to the read-only case. */
const KNOWN_TYPES = [
  'text',
  'number',
  'select',
  'multi_select',
  'date',
  'checkbox',
  'url',
] as const;

export function isKnownPropertyType(type: string): boolean {
  return (KNOWN_TYPES as readonly string[]).includes(type);
}

/**
 * The empty option's value in a select.
 *
 * The empty string rather than an invented token, for the reason the board settled on the same
 * sentinel: `readSelectValue` already treats an empty string as no value, so no declared option can
 * collide with it and there is no `__none__` for somebody to declare by accident.
 */
const UNSET_VALUE = '';

/** What the empty option is called, matching the board's word for the same absence. */
const UNSET_LABEL = 'Unset';

/** The select's own box, drawn as the rest of the system draws a control. */
const selectClasses = cn(
  blueprintFrame,
  'w-full bg-background px-3 py-2 font-body text-base text-foreground',
  focusRing,
  disabledState,
);

export function PropertyInput(props: PropertyInputProps): ReactNode {
  switch (props.property.type) {
    case 'text':
      return <TypedValue {...props} kind="text" />;

    case 'url':
      return <TypedValue {...props} kind="url" />;

    case 'number':
      return <TypedValue {...props} kind="number" />;

    case 'select':
      return <SelectValue {...props} />;

    case 'multi_select':
      return <MultiSelectValue {...props} />;

    case 'date':
      return <DateValue {...props} />;

    case 'checkbox':
      return <CheckboxValue {...props} />;

    default:
      return (
        <ReadOnlyValue
          {...props}
          note={`This build does not know the "${props.property.type}" property type, so the value is shown as it is stored and cannot be edited here.`}
        />
      );
  }
}

interface Draft {
  /** What is on screen, which is what somebody is part-way through typing. */
  readonly draft: string;
  readonly setDraft: (text: string) => void;

  /** The text this field is known to have handed over, or the text it was given. */
  readonly sent: string;

  /** Hands a value over and remembers the text it was, so the same edit is never written twice. */
  readonly send: (text: string, value: PropertyValue) => void;
}

/**
 * A field's draft, and the value it last handed over.
 *
 * Both are replaced whenever the stored value moves - after a write lands, after a reload, after a
 * refusal put the old value back. That comparison happens during render rather than in an effect,
 * so no render ever shows a draft belonging to a value that is no longer there.
 */
function useDraft(stored: string, onCommit: (value: PropertyValue) => void): Draft {
  const [draft, setDraft] = useState(stored);
  const [sent, setSent] = useState(stored);
  const [seen, setSeen] = useState(stored);

  if (stored !== seen) {
    setSeen(stored);
    setDraft(stored);
    setSent(stored);
  }

  return {
    draft,
    setDraft,
    sent,
    send: (text, value) => {
      setSent(text);
      onCommit(value);
    },
  };
}

type TypedKind = 'text' | 'url' | 'number';

function TypedValue(props: PropertyInputProps & { readonly kind: TypedKind }): ReactNode {
  const { item, property, onCommit, disabled = false, error = null, kind } = props;

  const stored = readPropertyText(item, property.key);
  const { draft, setDraft, sent, send } = useDraft(stored, onCommit);

  function commit(): void {
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
    <Field label={property.label} required={property.required} error={error}>
      {(control) => (
        <Input
          {...control}
          type={kind}
          value={draft}
          required={property.required}
          disabled={disabled}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            // Enter is the explicit action for somebody who types and does not move on.
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            }
          }}
        />
      )}
    </Field>
  );
}

function SelectValue(props: PropertyInputProps): ReactNode {
  const { item, property, onCommit, disabled = false, error = null } = props;

  const current = readSelectValue(item, property.key);

  // The declared options, plus whatever this item actually holds if the schema has moved on since
  // it was written. Dropping the stored value would make the control report some other option as
  // the current one, which is a lie about the item.
  const options =
    current !== null && !property.options.includes(current)
      ? [current, ...property.options]
      : property.options;

  return (
    <Field label={property.label} required={property.required} error={error}>
      {(control) => (
        <select
          {...control}
          value={current ?? UNSET_VALUE}
          required={property.required}
          disabled={disabled}
          onChange={(event) => {
            const next = event.target.value;
            onCommit(next === UNSET_VALUE ? null : next);
          }}
          className={selectClasses}
        >
          {/* Clearing has to be reachable from the control that set it: a property somebody
              filled in by mistake is otherwise permanent. */}
          <option value={UNSET_VALUE}>{UNSET_LABEL}</option>

          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

function MultiSelectValue(props: PropertyInputProps): ReactNode {
  const { item, property, onCommit, disabled = false, error = null } = props;

  const raw: unknown = item.properties[property.key];
  const current = Array.isArray(raw)
    ? raw.filter((entry): entry is string => typeof entry === 'string')
    : [];

  const options = [
    ...property.options,
    // Same reason as the select: a value the schema no longer declares is still on the item, and a
    // control that hid it would report the item as holding less than it does.
    ...current.filter((value) => !property.options.includes(value)),
  ];

  // A fieldset rather than <Field>, which wires a label to one control by id. A group of checkboxes
  // has no single control to point at, so the group is named by its legend instead.
  return (
    <fieldset disabled={disabled} className="flex flex-col gap-1 border-0 p-0">
      <legend className="font-heading text-xs uppercase tracking-[0.08em] text-muted">
        {property.label}
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
            checked={current.includes(option)}
            className={cn(focusRing, disabledState)}
            onChange={(event) => {
              const next = event.target.checked
                ? [...current, option]
                : current.filter((value) => value !== option);

              // An empty list clears the property rather than storing an empty array: "nothing
              // selected" and "no value" are the same fact, and the contract already has a way to
              // say it.
              onCommit(next.length === 0 ? null : next);
            }}
          />
          {option}
        </label>
      ))}

      {error === null ? null : (
        <p role="alert" className="font-body text-sm text-foreground">
          {error}
        </p>
      )}
    </fieldset>
  );
}

/** A complete calendar date, which is the only thing worth sending. */
const COMPLETE_DATE = /^\d{4}-\d{2}-\d{2}$/;

function DateValue(props: PropertyInputProps): ReactNode {
  const { item, property, onCommit, disabled = false, error = null } = props;

  // The stored text, straight in and straight back out. A date property carries no time and no zone
  // deliberately - "the 3rd" must stay the 3rd for a reader in another zone - and building a Date
  // from it to fill the field is exactly how it becomes the 2nd.
  const stored = readDateValue(item, property.key) ?? '';
  const raw = readPropertyText(item, property.key);

  const [draft, setDraft] = useState(stored);
  const [seen, setSeen] = useState(stored);
  const [sent, setSent] = useState(stored);
  const [incomplete, setIncomplete] = useState(false);

  if (stored !== seen) {
    setSeen(stored);
    setDraft(stored);
    setSent(stored);
    setIncomplete(false);
  }

  function send(value: string | null): void {
    setSent(value ?? '');
    onCommit(value);
  }

  // Something is stored, and it is not a calendar date. Showing an empty date field over it would
  // claim the property is unset and offer to overwrite it without ever saying what was there.
  if (stored.length === 0 && raw.length > 0) {
    return (
      <ReadOnlyValue
        {...props}
        note={`Stored as "${raw}", which is not a date this field can show. It is left as it is rather than being overwritten.`}
      />
    );
  }

  function commit(): void {
    // Against what was last handed over rather than against what is stored. Picking a date commits
    // immediately, and the blur that follows would otherwise commit the same value a second time -
    // one edit, two requests, and on a slow link two chances for them to land out of order.
    if (draft === sent) {
      setIncomplete(false);
      return;
    }

    if (draft.length === 0) {
      send(null);
      return;
    }

    if (COMPLETE_DATE.test(draft)) {
      send(draft);
      return;
    }

    // Half a date is not a date. A field mid-edit reports an empty value in every browser that
    // draws its own picker, so an incomplete draft is said out loud rather than stored as a clear.
    setIncomplete(true);
  }

  return (
    <Field
      label={property.label}
      required={property.required}
      error={error ?? (incomplete ? 'Enter a date as year, month and day.' : null)}
    >
      {(control) => (
        <Input
          {...control}
          type="date"
          value={draft}
          required={property.required}
          disabled={disabled}
          onChange={(event) => {
            const next = event.target.value;
            setDraft(next);
            setIncomplete(false);

            // A complete date is a finished edit: choosing one from the field's own picker produces
            // exactly this and nothing follows it, so waiting for a blur would leave somebody
            // looking at a date they picked and did not save.
            if (next !== sent && COMPLETE_DATE.test(next)) {
              send(next);
            }
          }}
          onBlur={commit}
        />
      )}
    </Field>
  );
}

function CheckboxValue(props: PropertyInputProps): ReactNode {
  const { item, property, onCommit, disabled = false, error = null } = props;

  // True or false, never null: a checkbox has two states and "unchecked" is one of them rather than
  // an absence. Clearing a checkbox property is a schema question, not a click.
  const checked = item.properties[property.key] === true;

  return (
    <Field label={property.label} required={property.required} error={error}>
      {(control) => (
        <input
          {...control}
          type="checkbox"
          checked={checked}
          required={property.required}
          disabled={disabled}
          className={cn('size-4 self-start', focusRing, disabledState)}
          onChange={(event) => {
            onCommit(event.target.checked);
          }}
        />
      )}
    </Field>
  );
}

function ReadOnlyValue(props: PropertyInputProps & { readonly note: string }): ReactNode {
  const { item, property, error = null, note } = props;

  return (
    <Field label={property.label} required={property.required} hint={note} error={error}>
      {(control) => <Input {...control} readOnly value={readPropertyText(item, property.key)} />}
    </Field>
  );
}
