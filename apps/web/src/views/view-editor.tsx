import { Button, Field, Icon, Input, Select } from '@nix/ui';
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import type { View } from './container-model';
import { EditorShell } from './editor-shell';
import type { ContainerData } from './use-container';
import { TEMPLATES, applyTemplate, type Template } from './templates';
import { VIEW_KINDS, findViewKind } from './view-kinds';

/**
 * Adding and configuring the ways a folder can be looked at.
 *
 * **Order is part of what is being edited**, which is why this saves the whole set rather than one
 * view at a time: a switcher's entries get dragged into an order about as often as an individual
 * view gets renamed, and per-view saves would make a reorder a sequence of writes that can
 * half-apply.
 *
 * The configuration a view needs depends on its kind, and only the fields that apply are shown. A
 * board offered a date property, or a calendar offered a grouping property, would be an invitation
 * to configure something the renderer ignores.
 */

export interface ViewEditorProps {
  readonly container: ContainerData;
  readonly open: boolean;
  readonly onClose: () => void;

  /** Renders as a column in the settings panel rather than as a dialog over the view. */
  readonly inline?: boolean;
}

/**
 * An identifier for a new view.
 *
 * Derived from the name, because a shared link carries it and `by-status` in an address is worth
 * more than a random string. Uniqueness is checked below rather than assumed; the server refuses a
 * duplicate anyway, and catching it here says which name to change.
 */
function idFor(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'view';

  if (!taken.includes(base)) {
    return base;
  }

  let suffix = 2;
  while (taken.includes(`${base}-${String(suffix)}`)) {
    suffix += 1;
  }

  return `${base}-${String(suffix)}`;
}

export function ViewEditor({
  container,
  open,
  onClose,
  inline = false,
}: ViewEditorProps): ReactNode {
  const stored = container.views?.views ?? [];
  const schema = container.schema?.properties ?? [];

  const [draft, setDraft] = useState<readonly View[]>(stored);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [openedWith, setOpenedWith] = useState(open);
  if (open !== openedWith) {
    setOpenedWith(open);
    if (open) {
      setDraft(stored);
      setError(null);
    }
  }

  // Which properties a kind may be configured from is the kind's own business, declared once in
  // the registry. Offering the rest would let somebody configure a view that cannot draw.

  function update(index: number, change: Partial<View>): void {
    setDraft((current) =>
      current.map((view, position) => (position === index ? { ...view, ...change } : view)),
    );
  }

  function move(index: number, by: number): void {
    setDraft((current) => {
      const next = [...current];
      const target = index + by;
      const moved = next[index];
      const displaced = next[target];

      if (moved === undefined || displaced === undefined) {
        return current;
      }

      next[index] = displaced;
      next[target] = moved;
      return next;
    });
  }

  /**
   * Applies a template and closes.
   *
   * It writes through the container rather than into this editor's draft, because a template sets
   * a schema as well as views and the schema is not this form's to hold. Closing on success is the
   * honest end: what it did is on the screen behind, not in here.
   */
  async function applyChosen(template: Template): Promise<void> {
    setSaving(true);
    setError(null);

    const refusal = await applyTemplate(template, container);

    setSaving(false);

    if (refusal === null) {
      onClose();
      return;
    }

    setError(refusal);
  }

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);

    // **The first view an item is given becomes what it opens on.** Building a board and watching
    // the screen not change is the whole of the bug this exists to prevent: the item kept opening
    // on its document, because that is what it had always said, and the person had no reason to
    // suspect a switcher had appeared above the thing they were already looking at.
    //
    // Only the first. Once an item offers views, "document" is a choice somebody can have made
    // deliberately, and adding a second view must not overrule it.
    const first = stored.length === 0 && draft.length > 0 ? draft[0]?.id : undefined;

    const refusal =
      first === undefined
        ? await container.setViews(draft)
        : await container.setViews(draft, first);

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
      title="Views for this item"
      onClose={onClose}
      onSave={() => {
        void save();
      }}
      saving={saving}
      saveLabel="Save views"
    >
      <div className="flex flex-col gap-4">
        <p className="text-base text-muted">
          A view is a way of looking at this item. Everybody who can see it sees the same views.
        </p>

        {error === null ? null : (
          <p role="alert" className="border border-foreground px-3 py-2 text-base">
            {error}
          </p>
        )}

        {draft.length === 0 ? (
          <p className="text-base text-muted">
            No views yet. Without one, this item shows a plain list.
          </p>
        ) : null}

        {/* Offered first, and only while there is nothing configured. Somebody who has already
            built a view does not want a row of buttons that would add a second one beside it. */}
        {draft.length === 0 ? (
          <div className="flex flex-col gap-2 rounded-md bg-surface p-3">
            <p className="text-sm text-muted">Start from a template</p>

            <div className="flex flex-wrap gap-2">
              {TEMPLATES.map((template) => (
                <Button
                  key={template.id}
                  variant="secondary"
                  className="flex-col items-start gap-0.5 px-3 py-2 text-left"
                  disabled={saving}
                  onClick={() => {
                    void applyChosen(template);
                  }}
                >
                  <span>{template.label}</span>
                  <span className="text-xs text-muted">{template.detail}</span>
                </Button>
              ))}
            </div>
          </div>
        ) : null}

        {draft.map((view, index) => (
          <div key={view.id} className="flex flex-col gap-2 border border-divider p-3">
            <div className="flex items-end gap-2">
              <Field label="Name" className="flex-1">
                {(control) => (
                  <Input
                    {...control}
                    value={view.name}
                    onChange={(event) => {
                      // The name changes; the identifier does not. A link somebody shared names
                      // the view, and renaming it must not break their link.
                      update(index, { name: event.target.value });
                    }}
                  />
                )}
              </Field>

              <Field label="Shown as" className="w-[150px]">
                {(control) => (
                  <Select
                    {...control}
                    value={view.kind}
                    onChange={(event) => {
                      update(index, { kind: event.target.value });
                    }}
                  >
                    {VIEW_KINDS.map((descriptor) => (
                      <option key={descriptor.kind} value={descriptor.kind}>
                        {descriptor.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>

              <Button
                variant="icon"
                aria-label={`Move ${view.name} earlier`}
                disabled={index === 0}
                onClick={() => {
                  move(index, -1);
                }}
              >
                <Icon icon={ChevronUp} size="sm" />
              </Button>

              <Button
                variant="icon"
                aria-label={`Move ${view.name} later`}
                disabled={index === draft.length - 1}
                onClick={() => {
                  move(index, 1);
                }}
              >
                <Icon icon={ChevronDown} size="sm" />
              </Button>

              <Button
                variant="icon"
                aria-label={`Remove ${view.name}`}
                onClick={() => {
                  setDraft((current) => current.filter((_, position) => position !== index));
                }}
              >
                <Icon icon={Trash2} size="sm" />
              </Button>
            </div>

            {/* One block for every property a kind is configured from, rather than one per kind.
                The two that used to be here were the same control twice: a label, a hint that
                changed when the schema had nothing to offer, and a select filtered to the property
                types the kind can use. All four of those come from the registry entry, and a kind
                that needs two properties configured gets two of these rather than a second copy
                of the block. */}
            {(findViewKind(view.kind)?.configures ?? []).map((configuration) => {
              const usable = schema.filter((property) => configuration.accepts(property));
              const chosen = view[configuration.field] ?? '';

              return (
                <Field
                  key={configuration.field}
                  label={configuration.label}
                  hint={usable.length === 0 ? configuration.emptyHint : configuration.hint}
                >
                  {(control) => (
                    <Select
                      {...control}
                      value={chosen}
                      onChange={(event) => {
                        const key = event.target.value;
                        update(index, {
                          [configuration.field]: key.length > 0 ? key : null,
                          ...configuration.clears,
                        });
                      }}
                    >
                      {/* The registry holds the wording, because whether the view is complete
                          without this property is the kind's fact, not this form's. */}
                      <option value="">{configuration.emptyChoice}</option>
                      {usable.map((property) => (
                        <option key={property.key} value={property.key}>
                          {property.label}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              );
            })}
          </div>
        ))}

        <Button
          variant="secondary"
          onClick={() => {
            setDraft((current) => [
              ...current,
              {
                id: idFor(
                  `View ${String(current.length + 1)}`,
                  current.map((view) => view.id),
                ),
                name: `View ${String(current.length + 1)}`,
                kind: 'list',
                columns: [],
                groupBy: null,
                groupOrder: [],
                dateProperty: null,
                sortBy: null,
                sortDescending: false,
                mode: null,
                coverProperty: null,
              },
            ]);
          }}
        >
          <Icon icon={Plus} size="sm" />
          Add a view
        </Button>
      </div>
    </EditorShell>
  );
}
