import { formulaFieldNames } from '@nix/sheet';
import { Button, Field, Icon, Input, Select, Text, cn, fieldLabel, focusRing } from '@nix/ui';
import { Plus, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import type { PropertyDefinition } from './container-model';
import { EditorShell } from './editor-shell';
import { PROPERTY_TYPES, isComputedType, propertyTypeLabel } from './property-types';
import type { ContainerData } from './use-container';

/**
 * Declaring the properties a folder gives its contents.
 *
 * **Bound to what this container declares, never to what it inherits.** The effective schema is
 * the merge of every ancestor's; saving that back would copy the inherited properties onto this
 * item and silently turn inheritance into a copy, after which changing the parent's schema would
 * stop reaching anything below. So the inherited ones are shown, greyed and uneditable, purely so
 * a person can see why a property they did not declare is appearing on their notes.
 *
 * The server is the authority on what is storable and it refuses with a reason naming the property
 * at fault. That reason is shown verbatim rather than being second-guessed here - two validators
 * that disagree is worse than one that is occasionally slower.
 */

export interface SchemaEditorProps {
  readonly container: ContainerData;
  readonly open: boolean;
  readonly onClose: () => void;

  /** Renders as a column in the settings panel rather than as a dialog over the view. */
  readonly inline?: boolean;
}

function hasOptions(type: string): boolean {
  return type === 'select' || type === 'multi_select';
}

/**
 * Every key a formula in this dialog may refer to.
 *
 * **The inherited properties count, and leaving them out was a hint that contradicted the panel
 * below it.** Evaluation reads the *effective* schema, so a property declared three levels up is
 * perfectly referenceable - and this dialog already lists those under "Inherited from above", in
 * the same scroll. A hint that called a key unavailable while the panel underneath showed it would
 * be the exact mistake it exists to prevent.
 */
interface Referenceable {
  readonly here: readonly string[];
  readonly above: readonly string[];
  readonly all: ReadonlySet<string>;
}

/**
 * The key lists, built once per render rather than once per property row.
 *
 * A formula input asks for these on every keystroke, and asking per row made the work quadratic in
 * the number of properties - fine at the ten a schema has today, not fine at forty. The one key a
 * row has to exclude is its own, which {@link exceptSelf} takes off the shared list.
 */
function referenceable(
  drafted: readonly PropertyDefinition[],
  inherited: readonly PropertyDefinition[],
): Referenceable {
  const here = drafted
    .filter((property) => property.key.length > 0)
    .map((property) => property.key);
  const above = inherited.map((property) => property.key);

  return { here, above, all: new Set([...here, ...above]) };
}

/** The same lists without the property doing the asking, which cannot refer to itself. */
function exceptSelf(available: Referenceable, key: string): Referenceable {
  if (key.length === 0 || !available.all.has(key)) {
    return available;
  }

  const here = available.here.filter((candidate) => candidate !== key);
  const above = available.above.filter((candidate) => candidate !== key);

  return { here, above, all: new Set([...here, ...above]) };
}

/** What a formula may refer to, said in the words the person is looking at. */
function referenceHint(available: Referenceable): string {
  const opening = 'Write a property in square brackets, as [estimate] * 2.';

  if (available.here.length === 0 && available.above.length === 0) {
    // Named for what the dialog is about: these are the properties the *children* carry, which is
    // what its own title and lead sentence say.
    return `${opening} Nothing else inside this folder carries a property yet.`;
  }

  const parts: string[] = [];
  if (available.here.length > 0) {
    parts.push(`Available here: ${available.here.map((key) => `[${key}]`).join(', ')}.`);
  }
  if (available.above.length > 0) {
    parts.push(`Inherited: ${available.above.map((key) => `[${key}]`).join(', ')}.`);
  }

  return `${opening} ${parts.join(' ')}`;
}

/**
 * What is wrong with an expression as it stands, or null.
 *
 * **Asked of the engine, not of a second parser written here.** `formulaFieldNames` is the same
 * parse the value will get when it is drawn, so a draft this accepts is a draft that evaluates -
 * two answers to "is this a formula" is exactly the thing a shared package exists to prevent.
 *
 * This is guidance while typing, not a gate: the save is still the server's to refuse, and a
 * reference to a key that is not declared *here* may well be declared above, which is why an
 * unknown name is reported as a note rather than as a refusal.
 */
function expressionProblem(expression: string, available: ReadonlySet<string>): string | null {
  const trimmed = expression.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const referenced = formulaFieldNames(trimmed);
  if (referenced === null) {
    return 'This is not written in a way the formula parser understands, so it will read as #PARSE!.';
  }

  const unknown = referenced.filter((name) => !available.has(name));
  return unknown.length === 0
    ? null
    : `${unknown.map((name) => `[${name}]`).join(', ')} ${unknown.length === 1 ? 'is not a property' : 'are not properties'} anything here declares, so it will read as #NAME?.`;
}

/** A key derived from a label: lower case, words joined by underscores. */
function keyFor(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function SchemaEditor({
  container,
  open,
  onClose,
  inline = false,
}: SchemaEditorProps): ReactNode {
  const declared = container.schema?.declared ?? [];
  const effective = container.schema?.properties ?? [];
  const inheritedOnly = effective.filter(
    (property) => !declared.some((own) => own.key === property.key),
  );

  const [draft, setDraft] = useState<readonly PropertyDefinition[]>(declared);
  const [inherit, setInherit] = useState(container.schema?.inherit ?? true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Reset whenever the dialog opens, so a cancelled edit is not still sitting there next time.
  // Keyed on `open` rather than done in an effect: a render that reads the wrong draft never
  // happens, because the state is replaced before the body is built.
  const [openedWith, setOpenedWith] = useState(open);
  if (open !== openedWith) {
    setOpenedWith(open);
    if (open) {
      setDraft(declared);
      setInherit(container.schema?.inherit ?? true);
      setError(null);
    }
  }

  // Once per render, not once per property row: every formula input reads these on every
  // keystroke, and building them per row made the work quadratic in the number of properties.
  const available = referenceable(draft, inheritedOnly);

  function update(index: number, change: Partial<PropertyDefinition>): void {
    setDraft((current) =>
      current.map((property, position) =>
        position === index ? { ...property, ...change } : property,
      ),
    );
  }

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);

    const refusal = await container.setSchema({ properties: draft, inherit });

    setSaving(false);

    if (refusal === null) {
      onClose();
      return;
    }

    setError(refusal);
  }

  return (
    <EditorShell
      inline={inline}
      open={open}
      title="Fields for the items inside this one"
      onClose={onClose}
      onSave={() => {
        void save();
      }}
      saving={saving}
      saveLabel="Save fields"
    >
      <div className="flex flex-col gap-4">
        <Text variant="bodySmall" tone="muted">
          Everything inside this folder can carry these properties, and so can everything inside the
          folders below it.
        </Text>

        {error === null ? null : (
          <Text variant="bodySmall" role="alert" className="border border-foreground px-3 py-2">
            {error}
          </Text>
        )}

        {draft.map((property, index) => (
          <div key={index} className="flex flex-col gap-2 border border-divider p-3">
            <div className="flex items-end gap-2">
              <Field label="Name" className="flex-1">
                {(control) => (
                  <Input
                    {...control}
                    value={property.label}
                    onChange={(event) => {
                      const label = event.target.value;

                      // The key follows the name until the property has been saved once; after
                      // that it is frozen, because values are stored under it and changing it
                      // would orphan every one of them.
                      const isNew = !declared.some((own) => own.key === property.key);
                      update(index, isNew ? { label, key: keyFor(label) } : { label });
                    }}
                  />
                )}
              </Field>

              <Field label="Type" className="w-[190px]">
                {(control) => (
                  <Select
                    {...control}
                    value={property.type}
                    onChange={(event) => {
                      const type = event.target.value;
                      update(index, {
                        type,
                        // Options belong only to the select types, and the server refuses a schema
                        // where anything else carries them.
                        options: hasOptions(type) ? property.options : [],

                        // Same rule for the expression, and the same refusal - but this one also
                        // matters after the fact: an expression left on a property retyped to text
                        // would start evaluating again the moment somebody retyped it back, having
                        // been out of sight in between.
                        expression: type === 'formula' ? (property.expression ?? '') : null,

                        // A computed property has no value to require. Left set, the save would be
                        // refused for a box the person ticked before they chose the type.
                        required: isComputedType(type) ? false : property.required,
                      });
                    }}
                  >
                    {PROPERTY_TYPES.map((type) => (
                      <option key={type.value} value={type.value}>
                        {type.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>

              <Button
                variant="icon"
                aria-label={`Remove ${property.label || 'this property'}`}
                onClick={() => {
                  setDraft((current) => current.filter((_, position) => position !== index));
                }}
              >
                <Icon icon={Trash2} size="sm" />
              </Button>
            </div>

            {hasOptions(property.type) ? (
              <Field
                label="Options"
                hint="One per line. A board's columns are chosen separately, so a board can show only some of these."
              >
                {(control) => (
                  <textarea
                    {...control}
                    value={property.options.join('\n')}
                    onChange={(event) => {
                      update(index, {
                        options: event.target.value
                          .split('\n')
                          .map((option) => option.trim())
                          .filter((option) => option.length > 0),
                      });
                    }}
                    rows={3}
                  />
                )}
              </Field>
            ) : null}

            {property.type === 'formula' ? (
              <FormulaField
                property={property}
                available={exceptSelf(available, property.key)}
                onChange={(expression) => {
                  update(index, { expression });
                }}
              />
            ) : null}

            {/* A computed property is never written, so there is no value for "required" to be
                about. Hidden rather than disabled: a checkbox that cannot mean anything here is a
                question with no answer, and the server refuses a schema that ticks it. */}
            {isComputedType(property.type) ? null : (
              <label className="flex items-center gap-2 text-base">
                <input
                  type="checkbox"
                  checked={property.required}
                  onChange={(event) => {
                    update(index, { required: event.target.checked });
                  }}
                  className={focusRing}
                />
                Required
              </label>
            )}
          </div>
        ))}

        <Button
          variant="secondary"
          onClick={() => {
            setDraft((current) => [
              ...current,
              { key: '', label: '', type: 'text', options: [], required: false },
            ]);
          }}
        >
          <Icon icon={Plus} size="sm" />
          Add a property
        </Button>

        {inheritedOnly.length === 0 ? null : (
          <div className="border-t border-divider pt-3">
            <p className={cn('mb-1', fieldLabel)}>Inherited from above</p>
            {/* Shown but not editable. Somebody needs to see why a property they did not declare is
                appearing on their notes; letting them edit it here would copy it onto this folder
                and quietly sever it from the parent that actually owns it. */}
            <ul className="flex flex-col gap-1">
              {inheritedOnly.map((property) => (
                <Text key={property.key} variant="bodySmall" as="li" tone="muted">
                  {property.label} · {propertyTypeLabel(property.type)}
                </Text>
              ))}
            </ul>

            <label className="mt-2 flex items-center gap-2 text-base">
              <input
                type="checkbox"
                checked={!inherit}
                onChange={(event) => {
                  setInherit(!event.target.checked);
                }}
                className={focusRing}
              />
              Ignore fields from items above this one
            </label>
          </div>
        )}
      </div>
    </EditorShell>
  );
}

/**
 * One formula's expression box.
 *
 * Named per property rather than "Formula", because a schema with three formulas would otherwise
 * put three identically-named textboxes in one dialog - the same problem `PropertyInput` solves for
 * a control repeated once per row, and the same answer.
 */
function FormulaField({
  property,
  available,
  onChange,
}: {
  readonly property: PropertyDefinition;
  readonly available: Referenceable;
  readonly onChange: (expression: string) => void;
}): ReactNode {
  const expression = property.expression ?? '';
  const problem = expressionProblem(expression, available.all);

  return (
    <Field
      label={`Formula for ${property.label || 'this field'}`}
      hint={referenceHint(available)}
      error={problem}
    >
      {(control) => (
        <Input
          {...control}
          value={expression}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      )}
    </Field>
  );
}
