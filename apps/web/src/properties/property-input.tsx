import {
  Button,
  Field,
  Input,
  Select,
  Text,
  Textarea,
  blueprintFrame,
  cn,
  disabledState,
  fieldLabel,
  focusRing,
} from '@nix/ui';
import { PROPERTY_FORMULA_HELP, SHEET_ERROR_CODES, type SheetErrorCode } from '@nix/sheet';
import { useId, useState, type ReactElement, type ReactNode } from 'react';

import { useWorkspaceMembers } from '../settings/use-workspace-members';
import { rollupAggregateLabel } from '../views/core/property-types';
import { readTimestampValue, readerZone, writeTimestampValue } from '../views/core/timestamps';

import { ImageValue } from './image-value';
import { PRIORITY_LEVELS } from './priority-levels';
import { useSelectFrecency } from './use-select-frecency';

import {
  UNSET_LABEL,
  UNSET_VALUE,
  readDateValue,
  readPropertyText,
  readSelectValue,
  type PropertyOwner,
  type PropertyDefinition,
  type PropertyValue,
} from '../views/core/container-model';

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

export type PropertyInputDensity = 'panel' | 'cell' | 'card';

export interface PropertyInputProps {
  readonly item: PropertyOwner;
  readonly property: PropertyDefinition;

  /**
   * Hands over the value to store for this property. Null clears it, per the merge contract, and
   * this is called once per completed edit rather than once per keystroke.
   */
  readonly onCommit: (value: PropertyValue) => void;

  readonly disabled?: boolean;
  /** Optional removal from the sequential tab order for compact summary-only surfaces. */
  readonly tabIndex?: number;

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
  'long_text',
  'number',
  'select',
  'multi_select',
  'date',
  'timestamp',
  'datetime',
  'checkbox',
  'url',
  'image',
  'due_date',
  'start_date',
  'completion',
  'priority',
  'estimate',
  'assignee',
  'formula',
  'rollup',
  'reminder',
] as const;

export function isKnownPropertyType(type: string): boolean {
  return (KNOWN_TYPES as readonly string[]).includes(type);
}

/**
 * The select inside a table cell: no frame, because the cell has a rule under it already and a
 * box inside a box reads as a double rule rather than as a control. Kept as a local, hand-inlined
 * class string rather than the `<Select>` primitive because a table row is denser than a form and
 * the primitive has no compact variant; `pointer-coarse:h-(--control-lg)` still gives phone rows
 * an even height and a 44px touch target, matching what the primitive gives the panel density.
 */
const cellSelectClasses = cn(
  'w-full border border-transparent bg-transparent px-2 py-1 font-body text-base text-foreground',
  'pointer-coarse:h-(--control-lg)',
  focusRing,
  disabledState,
);

export function PropertyInput(props: PropertyInputProps): ReactNode {
  switch (props.property.type) {
    case 'text':
      return <TypedValue {...props} kind="text" />;

    case 'long_text':
      return <LongTextValue {...props} />;

    case 'url':
      return <TypedValue {...props} kind="url" />;

    // A picker over an address, because an address is what it holds. **Still not a file picker**:
    // there is no file or media model in this build to pick from, and a control that opened one
    // would be offering something the system cannot store. Choosing, pasting or dragging a picture
    // in all hand over a URL; the upload arrives with the media model.
    case 'image':
      return <ImageValue {...props} />;

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

    // A date or a moment: a synced event toggles between all-day and timed from one edit to the
    // next on the provider's side, so this is the one property that has to hold either shape.
    case 'datetime':
      return <DateTimeValue {...props} />;

    case 'checkbox':
      return <CheckboxValue {...props} />;

    // Stored exactly as a timestamp is, but it is an instant somebody is told about rather than a
    // time something happens - see `ReminderValue` for why it is edited in the reader's own zone.
    case 'reminder':
      return <ReminderValue {...props} />;

    // The task types (3.1) edit through the controls of the shapes they store: a due date IS a
    // date to every hand that touches it, and the meaning lives in the schema, not the control.
    case 'due_date':
    case 'start_date':
      return <DateValue {...props} />;

    case 'completion':
      return <CheckboxValue {...props} />;

    case 'priority':
      return <PriorityValue {...props} />;

    case 'estimate':
      return <TypedValue {...props} kind="number" />;

    // A person, chosen from the workspace rather than typed as their identifier - see
    // `AssigneeValue` for why this is not just another select.
    case 'assignee':
      return <AssigneeValue {...props} />;

    // Computed on read and never written - see `ComputedValue` for why both are results rather
    // than fields somebody cannot type into. A formula is evaluated in this build and a rollup
    // arrives folded from the server (ADR-0044); neither is anything a control could write to.
    case 'formula':
    case 'rollup':
      return <ComputedValue {...props} />;

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
  readonly tabIndex?: number;
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
function ValueShell(props: ValueShellProps): ReactNode {
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

interface MultiSelectDraft {
  /** What is checked on screen, which is every choice made so far, sent or not. */
  readonly selection: readonly string[];

  /** Applies one checkbox's change to the selection and sends the whole thing. */
  readonly toggle: (option: string, checked: boolean) => void;
}

/** Whether two option lists hold the same entries, order aside. */
function sameOptions(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value) => b.includes(value));
}

/**
 * A multi-select's draft: every box checked so far, kept apart from what the item last reported.
 *
 * **The bug this replaces.** Each checkbox used to build its next list from the item's own value -
 * "as last saved" - rather than from what was on screen. Two taps close together both read that
 * same stale value before either write returned, so the second tap's request carried only its own
 * box and silently dropped the first. Keeping the selection here, updated the instant a box is
 * tapped, means the second tap builds on the first's choice rather than on the server's last
 * answer - the same fix `useDraft` above makes for typed fields, for the same shape of race.
 *
 * **Sends one write per tap rather than debouncing**, each carrying the whole selection as it
 * stands at that moment. However the two responses land, the last request sent is the one with
 * every choice, so the item ends up holding what is on screen rather than whichever tap's request
 * happened to answer last.
 */
function useMultiSelectDraft(
  stored: readonly string[],
  onCommit: (value: PropertyValue) => void,
): MultiSelectDraft {
  const [selection, setSelection] = useState<readonly string[]>(stored);
  const [seen, setSeen] = useState<readonly string[]>(stored);

  if (!sameOptions(stored, seen)) {
    setSeen(stored);
    setSelection(stored);
  }

  return {
    selection,
    toggle: (option, checked) => {
      const next = checked ? [...selection, option] : selection.filter((value) => value !== option);
      setSelection(next);

      // An empty list clears the property rather than storing an empty array: "nothing selected"
      // and "no value" are the same fact, and the contract already has a way to say it.
      onCommit(next.length === 0 ? null : next);
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
          tabIndex={props.tabIndex}
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

/**
 * Plain text that runs to several lines. Commits on blur, as the one-line field does, but Enter is
 * a line break here rather than the explicit "done" gesture - which is the whole reason this is not
 * a `TypedValue` kind. Escape puts back the text this field last handed over, so a cancelled edit
 * is not written by the blur that follows it.
 *
 * In a cell the box rests as one unwrapped row, so the cell shows the first line like a one-line
 * value does, and opens out to the whole text only while somebody is editing it.
 */
function LongTextValue(props: PropertyInputProps): ReactNode {
  const { item, property, onCommit, disabled = false, density = 'panel' } = props;

  const stored = readPropertyText(item, property.key);
  const { draft, setDraft, sent, send } = useDraft(stored, onCommit);
  const [editing, setEditing] = useState(false);
  const collapsed = density !== 'panel' && !editing;

  function commit(): void {
    if (draft === sent) {
      return;
    }

    send(draft, draft.length === 0 ? null : draft);
  }

  return (
    <ValueShell {...props}>
      {(control) => (
        <Textarea
          {...control}
          tabIndex={props.tabIndex}
          autoGrow={!collapsed}
          rows={collapsed ? (density === 'card' ? 3 : 1) : undefined}
          wrap={collapsed && density === 'cell' ? 'off' : 'soft'}
          maxLength={8000}
          className="max-h-64"
          tone={density === 'cell' ? 'plain' : 'default'}
          value={draft}
          required={property.required}
          disabled={disabled}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onFocus={() => {
            setEditing(true);
          }}
          onBlur={() => {
            setEditing(false);
            commit();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setDraft(sent);
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
  const frecency = useSelectFrecency(property.key);

  // The declared options, plus whatever this item actually holds if the schema has moved on since
  // it was written. Dropping the stored value would make the control report some other option as
  // the current one, which is a lie about the item. The declared order is kept; what this person
  // usually picks is repeated ahead of it (see `use-select-frecency.ts`).
  const options =
    current !== null && !property.options.includes(current)
      ? [current, ...property.options]
      : property.options;
  const recent = frecency.recent(options, (option) => option);
  const choices = (
    <ChoiceGroups
      recent={recent.map((option) => ({ id: option, label: option }))}
      all={options.map((option) => ({ id: option, label: option }))}
    />
  );

  function choose(next: string): void {
    if (next !== UNSET_VALUE) {
      frecency.remember(next);
    }
    onCommit(next === UNSET_VALUE ? null : next);
  }

  return (
    <ValueShell {...props}>
      {(control) =>
        density === 'cell' ? (
          <select
            {...control}
            tabIndex={props.tabIndex}
            value={current ?? UNSET_VALUE}
            required={property.required}
            disabled={disabled}
            onChange={(event) => {
              choose(event.target.value);
            }}
            className={cellSelectClasses}
          >
            {/* Clearing has to be reachable from the control that set it: a property somebody
                filled in by mistake is otherwise permanent. */}
            <option value={UNSET_VALUE}>{UNSET_LABEL}</option>

            {choices}
          </select>
        ) : (
          <Select
            {...control}
            tabIndex={props.tabIndex}
            value={current ?? UNSET_VALUE}
            required={property.required}
            disabled={disabled}
            onChange={(event) => {
              choose(event.target.value);
            }}
          >
            {/* Clearing has to be reachable from the control that set it: a property somebody
                filled in by mistake is otherwise permanent. */}
            <option value={UNSET_VALUE}>{UNSET_LABEL}</option>

            {choices}
          </Select>
        )
      }
    </ValueShell>
  );
}

/** One assignee option offered by the picker: an identifier, and what to call it. */
interface AssigneeOption {
  readonly id: string;
  readonly label: string;
}

/**
 * A choice list's options: the declared list as it is, preceded - when this person has a history
 * here - by a "Recent" group repeating their usual picks. Two `<option>`s may then share a value;
 * the browser selects the first, which shows the same label.
 */
function ChoiceGroups({
  recent,
  all,
}: {
  readonly recent: readonly AssigneeOption[];
  readonly all: readonly AssigneeOption[];
}): ReactNode {
  const options = all.map((option) => (
    <option key={option.id} value={option.id}>
      {option.label}
    </option>
  ));
  if (recent.length === 0) {
    return options;
  }
  return (
    <>
      <optgroup label="Recent">
        {recent.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </optgroup>
      <optgroup label="All options">{options}</optgroup>
    </>
  );
}

/**
 * The assignee property: a picker over the workspace's members, storing a principal's identifier
 * rather than a box somebody types one into.
 *
 * **Three states a plain select never has to hold, all told apart in words.** The member list can
 * still be loading, which says so rather than showing an empty list that reads as "nobody is
 * here". Its read can fail, which says that too and keeps showing whatever is stored - a lookup
 * failing is not a reason to also hide the value. And the item can hold an identifier the list does
 * not currently carry, because the person left the workspace or the value predates them: that
 * identifier is offered as its own option and shown as the current selection rather than dropped or
 * quietly reported as somebody else. A control that reassigns an item because a lookup failed is
 * worse than one that admits it does not know the name.
 *
 * The unset option is the same word and the same value SelectValue clears through - one vocabulary
 * for "nothing chosen" rather than a second one invented for people.
 */
function AssigneeValue(props: PropertyInputProps): ReactNode {
  const { item, property, onCommit, disabled = false, density = 'panel' } = props;

  const { status, members, error: membersError } = useWorkspaceMembers();
  const current = readSelectValue(item, property.key);

  const known =
    current === null ? null : (members.find((member) => member.subjectId === current) ?? null);

  // The declared members, plus the item's own identifier when the list cannot vouch for it. Same
  // reasoning as `SelectValue`'s stored-but-undeclared option: dropping it would make the control
  // report the item as unassigned, which is a lie about the item rather than a gap in the roster.
  const memberOptions: readonly AssigneeOption[] = members.map((member) => ({
    id: member.subjectId,
    label: member.subjectDisplayName,
  }));

  const frecency = useSelectFrecency(property.key);
  const options: readonly AssigneeOption[] =
    current !== null && known === null
      ? [{ id: current, label: current }, ...memberOptions]
      : memberOptions;
  const choices = (
    <ChoiceGroups recent={frecency.recent(options, (option) => option.id)} all={options} />
  );

  function choose(next: string): void {
    if (next !== UNSET_VALUE) {
      frecency.remember(next);
    }
    onCommit(next === UNSET_VALUE ? null : next);
  }

  const hint =
    status === 'loading'
      ? 'Loading the workspace members.'
      : status === 'error'
        ? `${membersError ?? 'The workspace members could not be loaded.'} Showing what is stored.`
        : current !== null && known === null
          ? 'This identifier is not among the workspace members currently loaded.'
          : undefined;

  return (
    <ValueShell {...props} {...(hint === undefined ? {} : { hint })}>
      {(control) =>
        density === 'cell' ? (
          <select
            {...control}
            tabIndex={props.tabIndex}
            value={current ?? UNSET_VALUE}
            required={property.required}
            disabled={disabled}
            onChange={(event) => {
              choose(event.target.value);
            }}
            className={cellSelectClasses}
          >
            {/* Clearing has to be reachable from the control that set it: a property somebody
                filled in by mistake is otherwise permanent. */}
            <option value={UNSET_VALUE}>{UNSET_LABEL}</option>

            {choices}
          </select>
        ) : (
          <Select
            {...control}
            tabIndex={props.tabIndex}
            value={current ?? UNSET_VALUE}
            required={property.required}
            disabled={disabled}
            onChange={(event) => {
              choose(event.target.value);
            }}
          >
            {/* Clearing has to be reachable from the control that set it: a property somebody
                filled in by mistake is otherwise permanent. */}
            <option value={UNSET_VALUE}>{UNSET_LABEL}</option>

            {choices}
          </Select>
        )
      }
    </ValueShell>
  );
}

/**
 * A priority is a closed four-step scale, so it is chosen, never typed: a free number box would
 * invite the 0 and the 7 the server refuses, and refusal after the fact is a worse control than a
 * list that only offers what is real.
 */
function PriorityValue(props: PropertyInputProps): ReactNode {
  const { item, property, onCommit, disabled = false, density = 'panel' } = props;

  const raw: unknown = item.properties[property.key];
  const current =
    typeof raw === 'number' && PRIORITY_LEVELS.some((level) => level.value === raw) ? raw : null;

  return (
    <ValueShell {...props}>
      {(control) =>
        density === 'cell' ? (
          <select
            {...control}
            tabIndex={props.tabIndex}
            value={current === null ? UNSET_VALUE : String(current)}
            required={property.required}
            disabled={disabled}
            onChange={(event) => {
              const next = event.target.value;
              onCommit(next === UNSET_VALUE ? null : Number(next));
            }}
            className={cellSelectClasses}
          >
            <option value={UNSET_VALUE}>{UNSET_LABEL}</option>

            {PRIORITY_LEVELS.map((level) => (
              <option key={level.value} value={String(level.value)}>
                {`${String(level.value)} - ${level.word}`}
              </option>
            ))}
          </select>
        ) : (
          <Select
            {...control}
            tabIndex={props.tabIndex}
            value={current === null ? UNSET_VALUE : String(current)}
            required={property.required}
            disabled={disabled}
            onChange={(event) => {
              const next = event.target.value;
              onCommit(next === UNSET_VALUE ? null : Number(next));
            }}
          >
            <option value={UNSET_VALUE}>{UNSET_LABEL}</option>

            {PRIORITY_LEVELS.map((level) => (
              <option key={level.value} value={String(level.value)}>
                {`${String(level.value)} - ${level.word}`}
              </option>
            ))}
          </Select>
        )
      }
    </ValueShell>
  );
}

function MultiSelectValue(props: PropertyInputProps): ReactNode {
  const { item, property, onCommit, disabled = false, error = null, density = 'panel' } = props;

  const raw: unknown = item.properties[property.key];
  const stored = Array.isArray(raw)
    ? raw.filter((entry): entry is string => typeof entry === 'string')
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

      {density === 'cell' ? (
        <select
          aria-label={`Time zone for ${controlLabel}`}
          value={draftZone}
          disabled={disabled}
          onChange={(event) => {
            setDraftZone(event.target.value);
            commit(draft, event.target.value);
          }}
          className={cellSelectClasses}
        >
          {zoneOptions(draftZone).map((zoneName) => (
            <option key={zoneName} value={zoneName}>
              {zoneName}
            </option>
          ))}
        </select>
      ) : (
        <Select
          aria-label={`Time zone for ${controlLabel}`}
          value={draftZone}
          disabled={disabled}
          onChange={(event) => {
            setDraftZone(event.target.value);
            commit(draft, event.target.value);
          }}
        >
          {zoneOptions(draftZone).map((zoneName) => (
            <option key={zoneName} value={zoneName}>
              {zoneName}
            </option>
          ))}
        </Select>
      )}

      {/* Said out loud rather than only drawn as an invalid frame. A pair of controls with no
          <Field> around them had no place to put the refusal, and a refusal with nowhere to go is
          a refusal nobody reads. */}
      {error === null || error.length === 0 ? null : (
        <Text variant="note" role="alert">
          {error}
        </Text>
      )}
    </div>
  );
}

/**
 * When to be reminded: a date and time in the reader's own zone, and a way to clear it.
 *
 * **The reader's zone, not a zone picker.** A reminder is an instant somebody is told about, on
 * whatever device they are holding; asking which city's clock it follows is a question about a
 * meeting, not about a nudge. So the field shows the stored instant converted to the reader's clock,
 * and writes what they pick in that same zone - still as RFC 9557 with its zone, which is the shape
 * Core's `PropertyType.Reminder` validation accepts (the same check a timestamp gets).
 *
 * **Clearing is its own control.** An empty `datetime-local` is easy to produce by accident on some
 * browsers; a button that says "Clear reminder" is not.
 */
function ReminderValue(props: PropertyInputProps): ReactNode {
  const { item, property, onCommit, disabled = false, error = null, density = 'panel' } = props;
  const controlLabel = controlName(density, item, property);
  const hintId = useId();
  const errorId = useId();

  const stored = readTimestampValue(item.properties, property.key);
  const raw = readPropertyText(item, property.key);
  const zone = readerZone();
  const local = stored === null ? '' : stored.at.setZone(zone).toFormat("yyyy-MM-dd'T'HH:mm");

  const [draft, setDraft] = useState(local);
  const [seen, setSeen] = useState(local);
  // When the field was drawn, for saying a reminder's time has passed. Read once rather than on
  // every render, which is what a render has to be: the same output for the same input.
  const [openedAt] = useState(() => Date.now());
  if (local !== seen) {
    setSeen(local);
    setDraft(local);
  }

  if (stored === null && raw.length > 0) {
    return (
      <ReadOnlyValue
        {...props}
        note={`Stored as "${raw}", which is not a time this field can show. It is left as it is rather than being overwritten.`}
      />
    );
  }

  function commit(nextLocal: string): void {
    if (nextLocal === local) return;
    if (nextLocal.length === 0) {
      onCommit(null);
      return;
    }
    const written = writeTimestampValue(nextLocal, zone);
    if (written !== null) onCommit(written);
  }

  const passed = stored !== null && stored.at.toMillis() <= openedAt;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="datetime-local"
          aria-label={controlLabel}
          aria-describedby={
            [
              density === 'cell' ? null : hintId,
              error === null || error.length === 0 ? null : errorId,
            ]
              .filter((id) => id !== null)
              .join(' ') || undefined
          }
          tone={density === 'cell' ? 'plain' : 'default'}
          value={draft}
          disabled={disabled}
          aria-invalid={error === null ? undefined : true}
          className="min-w-0 flex-1"
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onBlur={() => {
            commit(draft);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit(draft);
          }}
        />
        {stored === null ? null : (
          <Button
            type="button"
            variant="ghost"
            disabled={disabled}
            aria-label={`Clear reminder for ${controlLabel}`}
            onClick={() => {
              setDraft('');
              onCommit(null);
            }}
          >
            Clear
          </Button>
        )}
      </div>
      {density === 'cell' ? null : (
        <Text variant="note" tone="muted" id={hintId}>
          {passed
            ? `This time has passed, so it will not remind you again. Times are in ${zone}.`
            : `You will be notified at this time, in ${zone}.`}
        </Text>
      )}
      {error === null || error.length === 0 ? null : (
        <Text variant="note" role="alert" id={errorId}>
          {error}
        </Text>
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

/**
 * A date or a moment: a date field, and an optional time in the reader's own zone.
 *
 * **All-day by default, timed once a time is given.** Leaving the time empty stores the bare
 * `yyyy-MM-dd` a plain {@link DateValue} would, and filling it in stores an RFC 9557 timestamp
 * built in the reader's own zone - unlike {@link TimestampValue}, whose zone is part of the value
 * and has to be shown and chosen, this property is always read and written in whichever zone the
 * person filling it in is sitting in.
 *
 * **Clearing the time returns the value to all-day.** There is no third "time was cleared" state:
 * a date with no time stored is exactly what an all-day event already looks like, on this property
 * as on the calendar it will be placed on.
 */
function DateTimeValue(props: PropertyInputProps): ReactNode {
  const { item, property, onCommit, disabled = false, error = null, density = 'panel' } = props;
  const controlLabel = controlName(density, item, property);
  const zone = readerZone();

  const stored = readTimestampValue(item.properties, property.key);
  const storedDate = stored === null ? readDateValue(item, property.key) : null;
  const raw = readPropertyText(item, property.key);

  const localDate =
    storedDate ?? (stored === null ? '' : stored.at.setZone(zone).toFormat('yyyy-MM-dd'));
  const localTime = stored === null ? '' : stored.at.setZone(zone).toFormat('HH:mm');

  const [draftDate, setDraftDate] = useState(localDate);
  const [draftTime, setDraftTime] = useState(localTime);
  const [seen, setSeen] = useState(`${localDate}|${localTime}`);
  const [sent, setSent] = useState(`${localDate}|${localTime}`);
  const [incomplete, setIncomplete] = useState(false);

  const seenKey = `${localDate}|${localTime}`;
  if (seenKey !== seen) {
    setSeen(seenKey);
    setDraftDate(localDate);
    setDraftTime(localTime);
    setSent(seenKey);
    setIncomplete(false);
  }

  // Something is stored, and it is neither a calendar date nor a timestamp this field can show.
  if (storedDate === null && stored === null && raw.length > 0) {
    return (
      <ReadOnlyValue
        {...props}
        note={`Stored as "${raw}", which is not a date or a time this field can show. It is left as it is rather than being overwritten.`}
      />
    );
  }

  function commit(nextDate: string, nextTime: string): void {
    const key = `${nextDate}|${nextTime}`;

    // Against what was last handed over rather than against what is stored, for the same reason
    // DateValue compares against `sent`: picking a value commits immediately, and the blur that
    // follows must not commit the same edit a second time.
    if (key === sent) {
      setIncomplete(false);
      return;
    }

    if (nextDate.length === 0) {
      setSent(key);
      setIncomplete(false);
      onCommit(null);
      return;
    }

    if (!COMPLETE_DATE.test(nextDate)) {
      // Half a date is not a date - said out loud rather than stored as a clear, the same rule
      // DateValue applies to a draft mid-edit.
      setIncomplete(true);
      return;
    }

    if (nextTime.length === 0) {
      setSent(key);
      setIncomplete(false);
      onCommit(nextDate);
      return;
    }

    const written = writeTimestampValue(`${nextDate}T${nextTime}`, zone);
    if (written === null) {
      setIncomplete(true);
      return;
    }

    setSent(key);
    setIncomplete(false);
    onCommit(written);
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label={controlLabel}
          tabIndex={props.tabIndex}
          type="date"
          tone={density === 'cell' ? 'plain' : 'default'}
          value={draftDate}
          required={property.required}
          disabled={disabled}
          aria-invalid={error === null && !incomplete ? undefined : true}
          onChange={(event) => {
            const next = event.target.value;
            setDraftDate(next);

            // A complete date is a finished edit for the date half, the same as DateValue: waiting
            // for a blur would leave somebody looking at a date they picked and did not save.
            if (next !== draftDate && COMPLETE_DATE.test(next)) {
              commit(next, draftTime);
            }
          }}
          onBlur={() => {
            commit(draftDate, draftTime);
          }}
        />

        <Input
          aria-label={`Time for ${controlLabel}`}
          tabIndex={props.tabIndex}
          type="time"
          tone={density === 'cell' ? 'plain' : 'default'}
          value={draftTime}
          disabled={disabled}
          onChange={(event) => {
            const next = event.target.value;
            setDraftTime(next);
            commit(draftDate, next);
          }}
          onBlur={() => {
            commit(draftDate, draftTime);
          }}
        />
      </div>

      {error !== null && error.length > 0 ? (
        <Text variant="note" role="alert">
          {error}
        </Text>
      ) : incomplete ? (
        <Text variant="note" role="alert">
          Enter a complete date, and a complete time if you set one.
        </Text>
      ) : null}
    </div>
  );
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
          tabIndex={props.tabIndex}
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

/**
 * A computed value: the result of a formula, not a field.
 *
 * **An `<output>` rather than a read-only `<input>`, and that is three fixes in one element.** It is
 * a labelable element, so the panel's label still points at it; it is not in the tab order, so a
 * column of three thousand computed cells does not put three thousand dead stops in the keyboard
 * path; and it carries an implicit live region, so a value that changes because somebody edited a
 * different property is announced rather than silently updated. That last one is asserted from the
 * element's semantics rather than proved - settling it needs a real screen reader, which this
 * environment does not have.
 *
 * **An error is shown as an error, with the sentence that says what to do about it.** The value a
 * formula produces can be one of the sheet's error codes, and a bare `#NAME?` in a field called
 * Total reads as a value rather than as a fault to somebody who has never used a spreadsheet. The
 * codes are explained by `PROPERTY_FORMULA_HELP`, which is this surface's own map: three of the
 * grid's sentences are false here, because there is no grid.
 *
 * **The explanation belongs to the panel, not to the table.** A panel shows one value at a time and
 * has room for a sentence; a column repeats whatever it is given once per row, so the expression
 * and the help would print under every cell and grow every row to say what the column header could
 * say once. In a table the code itself is the value, which is what a spreadsheet shows too.
 */
function ComputedValue(props: PropertyInputProps): ReactNode {
  const { item, property, density = 'panel' } = props;

  const text = readPropertyText(item, property.key);
  const code = (SHEET_ERROR_CODES as readonly string[]).includes(text)
    ? (text as SheetErrorCode)
    : null;

  const source = describeSource(property);

  const panelError = code === null ? null : `${code} - ${PROPERTY_FORMULA_HELP[code]}`;

  return (
    <ValueShell
      {...props}
      error={density === 'cell' ? null : panelError}
      {...(density === 'cell' ? {} : { hint: source })}
    >
      {(control) => (
        <output
          {...control}
          className={cn(
            density === 'cell'
              ? 'block w-full px-2 py-1 font-body text-base text-foreground'
              : cn(
                  blueprintFrame,
                  'block w-full bg-background px-3 py-2 font-body text-base text-foreground',
                ),
          )}
        >
          {text}
        </output>
      )}
    </ValueShell>
  );
}

/**
 * Where a computed value comes from, said in one sentence.
 *
 * Not the same sentence for the two computed types, because they do not answer the same question:
 * a formula is about this item and a rollup is about the items inside it, and somebody reading a
 * number they cannot edit needs to know which.
 */
function describeSource(property: PropertyDefinition): string {
  if (property.type === 'rollup') {
    const fold = rollupAggregateLabel(property.aggregate ?? 'count').toLowerCase();
    return property.source == null
      ? `${capitalize(fold)} of the items inside this one.`
      : `${capitalize(fold)} of "${property.source}" across the items inside this one.`;
  }

  return property.expression == null
    ? 'This is a formula property, computed from this item’s other properties.'
    : `Computed from this item’s other properties: ${property.expression}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function ReadOnlyValue(props: PropertyInputProps & { readonly note: string }): ReactNode {
  const { item, property, note, density = 'panel' } = props;

  return (
    <ValueShell {...props} hint={note}>
      {(control) => (
        <Input
          {...control}
          tabIndex={props.tabIndex}
          readOnly
          tone={density === 'cell' ? 'plain' : 'default'}
          value={readPropertyText(item, property.key)}
        />
      )}
    </ValueShell>
  );
}
