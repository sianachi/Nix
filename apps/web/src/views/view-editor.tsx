import { Button, Dialog, Field, Icon, Input } from '@nix/ui';
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import type { View } from './container-model';
import type { ContainerData } from './use-container';

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
}

const KINDS = [
  { value: 'list', label: 'List' },
  { value: 'board', label: 'Board' },
  { value: 'calendar', label: 'Calendar' },
] as const;

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

export function ViewEditor({ container, open, onClose }: ViewEditorProps): ReactNode {
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

  // Only a single-select can produce a bounded set of columns, and only a date can place an item
  // on a month. Offering the rest would let somebody configure a view that cannot draw.
  const groupable = schema.filter((property) => property.type === 'select');
  const dateProperties = schema.filter((property) => property.type === 'date');

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

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);

    const refusal = await container.setViews(draft);

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
      title="Views for this folder"
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
            {saving ? 'Saving…' : 'Save views'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-[13px] text-neutral-700">
          A view is a way of looking at this folder. Everybody who can see the folder sees the same
          views.
        </p>

        {error === null ? null : (
          <p role="alert" className="border border-foreground px-3 py-2 text-[13px]">
            {error}
          </p>
        )}

        {draft.length === 0 ? (
          <p className="text-[13px] text-neutral-700">
            No views yet. Without one, this folder shows a plain list.
          </p>
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
                  <select
                    {...control}
                    value={view.kind}
                    onChange={(event) => {
                      update(index, { kind: event.target.value });
                    }}
                    className="w-full rounded-none border border-divider bg-background px-3 py-2 text-[14px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    {KINDS.map((kind) => (
                      <option key={kind.value} value={kind.value}>
                        {kind.label}
                      </option>
                    ))}
                  </select>
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

            {view.kind === 'board' ? (
              <Field
                label="Group by"
                hint={
                  groupable.length === 0
                    ? 'This folder has no select property yet. Add one under Properties first.'
                    : 'Only a select property can become columns.'
                }
              >
                {(control) => (
                  <select
                    {...control}
                    value={view.groupBy ?? ''}
                    onChange={(event) => {
                      const groupBy = event.target.value;
                      update(index, {
                        groupBy: groupBy.length > 0 ? groupBy : null,

                        // The column list belonged to the old property and means nothing under a
                        // new one. Cleared rather than carried, so the board falls back to the
                        // property's own options.
                        groupOrder: [],
                      });
                    }}
                    className="w-full rounded-none border border-divider bg-background px-3 py-2 text-[14px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    <option value="">Choose a property</option>
                    {groupable.map((property) => (
                      <option key={property.key} value={property.key}>
                        {property.label}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            ) : null}

            {view.kind === 'calendar' ? (
              <Field
                label="Place by"
                hint={
                  dateProperties.length === 0
                    ? 'This folder has no date property yet. Add one under Properties first.'
                    : 'Items appear on the day this property names.'
                }
              >
                {(control) => (
                  <select
                    {...control}
                    value={view.dateProperty ?? ''}
                    onChange={(event) => {
                      const dateProperty = event.target.value;
                      update(index, {
                        dateProperty: dateProperty.length > 0 ? dateProperty : null,
                      });
                    }}
                    className="w-full rounded-none border border-divider bg-background px-3 py-2 text-[14px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    <option value="">Choose a property</option>
                    {dateProperties.map((property) => (
                      <option key={property.key} value={property.key}>
                        {property.label}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            ) : null}
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
              },
            ]);
          }}
        >
          <Icon icon={Plus} size="sm" />
          Add a view
        </Button>
      </div>
    </Dialog>
  );
}
