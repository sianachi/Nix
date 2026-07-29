import { Field, Input, blueprintFrame, cn, disabledState, focusRing } from '@nix/ui';
import { useId, useState, type ReactElement, type ReactNode } from 'react';

import { readTimestampValue, readerZone, writeTimestampValue } from '../views/timestamps';

import {
  UNSET_LABEL,
  UNSET_VALUE,
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
 *
 * **Two densities, one set of controls.** The same control is drawn in a property panel, where it
 * needs its own label and its own frame, and in a table cell, where the column header is already
 * the label and the cell already has a rule under it. That is a real prop and not a `className`
 * passed in from the call site: a component whose styling forks at its callers has as many
 * appearances as it has callers, and none of them is the component's.
 */

export type PropertyInputDensity = 'panel' | 'cell';

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

  /**
   * Where this control is being drawn.
   *
   * `panel` labels itself and draws its own frame. `cell` does neither - the column header is the
   * label, and a framed box inside a ruled cell is a double rule - so it names itself after its
   * row instead, the way a control repeated once per row has to.
   */
  readonly density?: PropertyInputDensity;
}

/** The types this build can edit. Anything else falls through to the read-only case. */
const KNOWN_TYPES = [
  'text',
  'number',
  'select',
  'multi_select',
  'date',
  'timestamp',
  'checkbox',
  'url',
] as const;

export function isKnownPropertyType(type: string): boolean {
  return (KNOWN_TYPES as readonly string[]).includes(type);
}

/** The select's own box, drawn as the rest of the system draws a control. */
const selectClasses = cn(
  blueprintFrame,
  'w-full bg-background px-3 py-2 font-body text-base text-foreground',
  focusRing,
  disabledState,
);

/**
 * The same select inside a table cell: no frame, because the cell has a rule under it already and
 * a box inside a box reads as a double rule rather than as a control.
 */
const cellSelectClasses = cn(
  'w-full border border-transparent bg-transparent px-2 py-1 font-body text-base text-foreground',
  focusRing,
  disabledState,
);

/** What a select's box is, at the density it is being drawn at. */
function selectBox(density: PropertyInputDensity): string {
  return density === 'cell' ? cellSelectClasses : selectClasses;
}

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

    case 'timestamp':
      return <TimestampValue {...props} />;

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

/**
 * The identifiers a control is handed, whichever shell wired them.
 *
 * A superset of `FieldControlProps`: the panel shell points a visible label at the control by id,
 * the cell shell has no visible label to point and names the control directly instead.
 */
interface ControlProps {
  readonly id?: string;
  readonly 'aria-label'?: string;
  readonly 'aria-describedby': string | undefined;
  readonly 'aria-invalid': true | undefined;
}

/**
 * What a control at cell density is called.
 *
 * Named per row rather than per property, matching the board's per-card control exactly: a table of
 * twelve rows would otherwise offer twelve controls all called "Status", and neither a screen reader
 * user nor a test could say which one they were operating.
 */
function controlName(
  density: PropertyInputDensity,
  item: Item,
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
function ValueShell(props: ValueShellProps): ReactNode {
  const { property, error = null, hint, density = 'panel', children } = props;

  if (density === 'cell') {
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
      })}

      {/* The refusal sits in the cell that caused it and nowhere else. A banner over the table
          would name a property and leave somebody counting rows to find which one. */}
      {invalid ? (
        <p id={noteId} role="alert" className="font-body text-sm text-foreground">
          {error}
        </p>
      ) : hint === undefined ? null : (
        <p id={noteId} className="font-body text-sm text-muted">
          {hint}
        </p>
      )}
    </div>
  );
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
  const { item, property, onCommit, disabled = false, density = 'panel', kind } = props;

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
    <ValueShell {...props}>
      {(control) => (
        <Input
          {...control}
          type={kind}
          tone={density === 'cell' ? 'plain' : 'default'}
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
    </ValueShell>
  );
}

function SelectValue(props: PropertyInputProps): ReactNode {
  const { item, property, onCommit, disabled = false, density = 'panel' } = props;

  const current = readSelectValue(item, property.key);

  // The declared options, plus whatever this item actually holds if the schema has moved on since
  // it was written. Dropping the stored value would make the control report some other option as
  // the current one, which is a lie about the item.
  const options =
    current !== null && !property.options.includes(current)
      ? [current, ...property.options]
      : property.options;

  return (
    <ValueShell {...props}>
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
          className={selectBox(density)}
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
    </ValueShell>
  );
}

function MultiSelectValue(props: PropertyInputProps): ReactNode {
  const { item, property, onCommit, disabled = false, error = null, density = 'panel' } = props;

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
  // has no single control to point at, so the group is named by its legend instead - and in a cell
  // the legend still names the group, it is simply not drawn, because the column header above it
  // says the same word.
  return (
    <fieldset disabled={disabled} className="flex flex-col gap-1 border-0 p-0">
      <legend
        className={
          density === 'cell'
            ? 'sr-only'
            : 'font-heading text-xs uppercase tracking-[0.08em] text-muted'
        }
      >
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

/**
 * A moment: a local time, and the zone it means.
 *
 * **The zone is shown and editable, not assumed.** A time with no zone is a time that changes
 * meaning when somebody else reads it, and the reader's own zone is only the right default - never
 * the right answer for a thing scheduled somewhere else.
 *
 * The offset is never typed. It is derived from the wall time and the zone when the value is
 * written, so it cannot disagree with them - which is exactly what the server refuses.
 */
function TimestampValue(props: PropertyInputProps): ReactNode {
  const { item, property, onCommit, disabled = false, error = null, density = 'panel' } = props;
  const controlLabel = controlName(density, item, property);

  const stored = readTimestampValue(item.properties, property.key);
  const raw = readPropertyText(item, property.key);
  const zone = stored?.zone ?? readerZone();

  // The wall clock as the local `datetime-local` field wants it, in the value's own zone rather
  // than the reader's - editing a meeting set in another city should show the time it was set for.
  const local = stored === null ? '' : stored.at.setZone(zone).toFormat("yyyy-MM-dd'T'HH:mm");

  const [draft, setDraft] = useState(local);
  const [draftZone, setDraftZone] = useState(zone);
  const [seen, setSeen] = useState(local);

  if (local !== seen) {
    setSeen(local);
    setDraft(local);
    setDraftZone(zone);
  }

  // Something is stored and it is not a timestamp. Showing an empty field over it would claim the
  // property is unset and offer to overwrite it without ever saying what was there.
  if (stored === null && raw.length > 0) {
    return (
      <ReadOnlyValue
        {...props}
        note={`Stored as "${raw}", which is not a time this field can show. It is left as it is rather than being overwritten.`}
      />
    );
  }

  function commit(nextLocal: string, nextZone: string): void {
    if (nextLocal.length === 0) {
      onCommit(null);
      return;
    }

    const written = writeTimestampValue(nextLocal, nextZone);
    if (written !== null) {
      onCommit(written);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <Input
        type="datetime-local"
        aria-label={controlLabel}
        tone={density === 'cell' ? 'plain' : 'default'}
        value={draft}
        disabled={disabled}
        aria-invalid={error === null ? undefined : true}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onBlur={() => {
          commit(draft, draftZone);
        }}
      />

      <select
        aria-label={`Time zone for ${controlLabel}`}
        value={draftZone}
        disabled={disabled}
        onChange={(event) => {
          setDraftZone(event.target.value);
          commit(draft, event.target.value);
        }}
        className={selectBox(density)}
      >
        {zoneOptions(draftZone).map((zoneName) => (
          <option key={zoneName} value={zoneName}>
            {zoneName}
          </option>
        ))}
      </select>

      {/* Said out loud rather than only drawn as an invalid frame. A pair of controls with no
          <Field> around them had no place to put the refusal, and a refusal with nowhere to go is
          a refusal nobody reads. */}
      {error === null || error.length === 0 ? null : (
        <p role="alert" className="font-body text-sm text-foreground">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The zones offered, with the value's own always among them.
 *
 * Read from the platform rather than shipped: the browser already carries the IANA database, and a
 * second copy would be bytes spent on something already installed. A build whose runtime cannot
 * enumerate them still offers the two that matter - the reader's, and whatever is already stored.
 */
function zoneOptions(current: string): readonly string[] {
  const supported =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];

  const all = supported.length > 0 ? supported : [readerZone()];
  return all.includes(current) ? all : [current, ...all];
}

function DateValue(props: PropertyInputProps): ReactNode {
  const { item, property, onCommit, disabled = false, error = null, density = 'panel' } = props;

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
    <ValueShell
      {...props}
      error={error ?? (incomplete ? 'Enter a date as year, month and day.' : null)}
    >
      {(control) => (
        <Input
          {...control}
          type="date"
          tone={density === 'cell' ? 'plain' : 'default'}
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
    </ValueShell>
  );
}

function CheckboxValue(props: PropertyInputProps): ReactNode {
  const { item, property, onCommit, disabled = false } = props;

  // True or false, never null: a checkbox has two states and "unchecked" is one of them rather than
  // an absence. Clearing a checkbox property is a schema question, not a click.
  const checked = item.properties[property.key] === true;

  return (
    <ValueShell {...props}>
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
    </ValueShell>
  );
}

function ReadOnlyValue(props: PropertyInputProps & { readonly note: string }): ReactNode {
  const { item, property, note, density = 'panel' } = props;

  return (
    <ValueShell {...props} hint={note}>
      {(control) => (
        <Input
          {...control}
          readOnly
          tone={density === 'cell' ? 'plain' : 'default'}
          value={readPropertyText(item, property.key)}
        />
      )}
    </ValueShell>
  );
}
