import { Button, Dialog, Field, Icon, Input } from '@nix/ui';
import { Plus, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import type { PropertyDefinition } from './container-model';
import type { ContainerData } from './use-container';

/**
 * Declaring the properties a folder gives its contents.
 *
 * **Bound to what this container declares, never to what it inherits.** The effective schema is
 * the merge of every ancestor's; saving that back would copy the inherited properties onto this
 * folder and silently turn inheritance into a copy, after which changing the parent's schema would
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
}

/** The types a person may choose, and what to call them. */
const TYPES = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'select', label: 'Select (one of a list)' },
  { value: 'multi_select', label: 'Multi-select (any of a list)' },
  { value: 'date', label: 'Date' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'url', label: 'Link' },
] as const;

function hasOptions(type: string): boolean {
  return type === 'select' || type === 'multi_select';
}

/** A key derived from a label: lower case, words joined by underscores. */
function keyFor(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function SchemaEditor({ container, open, onClose }: SchemaEditorProps): ReactNode {
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
    <Dialog
      open={open}
      title="Properties for this folder"
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              void save();
            }}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save properties'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-base text-muted">
          Everything inside this folder can carry these properties, and so can everything inside the
          folders below it.
        </p>

        {error === null ? null : (
          <p role="alert" className="border border-foreground px-3 py-2 text-base">
            {error}
          </p>
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
                  <select
                    {...control}
                    value={property.type}
                    onChange={(event) => {
                      const type = event.target.value;
                      update(index, {
                        type,
                        // Options belong only to the select types, and the server refuses a schema
                        // where anything else carries them.
                        options: hasOptions(type) ? property.options : [],
                      });
                    }}
                    className="w-full rounded-none border border-divider bg-background px-3 py-2 text-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    {TYPES.map((type) => (
                      <option key={type.value} value={type.value}>
                        {type.label}
                      </option>
                    ))}
                  </select>
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
                    className="w-full rounded-none border border-divider bg-background px-3 py-2 text-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  />
                )}
              </Field>
            ) : null}

            <label className="flex items-center gap-2 text-base">
              <input
                type="checkbox"
                checked={property.required}
                onChange={(event) => {
                  update(index, { required: event.target.checked });
                }}
                className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              />
              Required
            </label>
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
            <p className="mb-1 font-heading text-xs uppercase tracking-[0.08em] text-muted">
              Inherited from above
            </p>
            {/* Shown but not editable. Somebody needs to see why a property they did not declare is
                appearing on their notes; letting them edit it here would copy it onto this folder
                and quietly sever it from the parent that actually owns it. */}
            <ul className="flex flex-col gap-1">
              {inheritedOnly.map((property) => (
                <li key={property.key} className="text-base text-muted">
                  {property.label} · {property.type}
                </li>
              ))}
            </ul>

            <label className="mt-2 flex items-center gap-2 text-base">
              <input
                type="checkbox"
                checked={!inherit}
                onChange={(event) => {
                  setInherit(!event.target.checked);
                }}
                className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              />
              Ignore properties from folders above this one
            </label>
          </div>
        )}
      </div>
    </Dialog>
  );
}
