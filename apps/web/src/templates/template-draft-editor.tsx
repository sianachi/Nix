import { Button, Field, Icon, Input, Select, Text, cn, focusRing } from '@nix/ui';
import { ChevronDown, ChevronUp, FileText, Plus, Trash2 } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';

import type { CollabSync } from '../editor/collab-sync';
import { NoteEditor } from '../editor/note-editor';
import type { PropertyDefinition, View } from '../views/core/container-model';
import { PROPERTY_TYPES } from '../views/core/property-types';
import { StructuredViewConfiguration } from '../views/core/structured-view-configuration';
import { findViewKind } from '../views/core/view-kinds';
import { SheetEditor } from '../views/sheet/sheet-editor';
import {
  STRUCTURED_RECIPES,
  viewForRecipe,
  type StructuredRecipeId,
} from '../views/wizard/structured-recipes';
import type { TemplateItem } from './template-api';

const TemplateCanvasEditor = lazy(async () => {
  const module = await import('../editor/canvas-editor');
  return { default: module.CanvasEditor };
});

export function templateDraftDocumentPath(
  templateId: string,
  operationId: string,
  sourceId: string,
): string {
  return `/collab/templates/${templateId}/drafts/${operationId}/items/${sourceId}/ws`;
}

export interface TemplateItemEdit {
  readonly title: string;
  readonly schema: TemplateItem['schema'];
  readonly views: TemplateItem['views'];
}

export type TemplateItemEdits = Readonly<Record<string, TemplateItemEdit>>;

interface FlatTemplateItem {
  readonly item: TemplateItem;
  readonly depth: number;
}

function flatten(root: TemplateItem, depth = 0): readonly FlatTemplateItem[] {
  return [{ item: root, depth }, ...root.children.flatMap((child) => flatten(child, depth + 1))];
}

function currentItem(item: TemplateItem, edits: TemplateItemEdits): TemplateItemEdit {
  return (
    edits[item.sourceId] ?? {
      title: item.title,
      schema: item.schema,
      views: item.views,
    }
  );
}

function declaredFields(edit: TemplateItemEdit): readonly PropertyDefinition[] {
  return edit.schema?.declared ?? [];
}

function replaceDeclaredFields(
  edit: TemplateItemEdit,
  fields: readonly PropertyDefinition[],
): TemplateItemEdit {
  const schema = edit.schema ?? { properties: [], declared: [], inherit: true };
  const originalDeclared = new Set(schema.declared.map((field) => field.key));
  const inherited = schema.properties.filter((field) => !originalDeclared.has(field.key));
  return {
    ...edit,
    schema: { ...schema, declared: [...fields], properties: [...inherited, ...fields] },
  };
}

function move<T>(entries: readonly T[], index: number, by: number): readonly T[] {
  const next = [...entries];
  const target = index + by;
  const entry = next[index];
  const displaced = next[target];
  if (entry === undefined || displaced === undefined) return entries;
  next[index] = displaced;
  next[target] = entry;
  return next;
}

function uniqueFieldKey(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}_${String(suffix)}`)) suffix += 1;
  return `${base}_${String(suffix)}`;
}

function prepareNewView(
  edit: TemplateItemEdit,
  kind: StructuredRecipeId,
): { readonly edit: TemplateItemEdit; readonly view: View } {
  const recipe = STRUCTURED_RECIPES.find((candidate) => candidate.id === kind);
  if (recipe === undefined) throw new Error(`The ${kind} view recipe is required.`);
  const effective = [...(edit.schema?.properties ?? [])];
  const declared = [...declaredFields(edit)];
  const taken = new Set(effective.map((field) => field.key));
  const recipeFields = recipe.properties.map((property) => {
    const reusable = effective.find(
      (candidate) => candidate.key === property.key && candidate.type === property.type,
    );
    if (reusable !== undefined) return reusable;
    const created = {
      ...property,
      key: uniqueFieldKey(property.key, taken),
      options: [...property.options],
    };
    taken.add(created.key);
    effective.push(created);
    declared.push(created);
    return created;
  });
  const nextEdit = replaceDeclaredFields(edit, declared);
  return {
    edit: nextEdit,
    view: { ...viewForRecipe(recipe, recipeFields), id: globalThis.crypto.randomUUID() },
  };
}

export function TemplateDraftEditor({
  root,
  edits,
  selectedSourceId,
  templateId,
  operationId,
  bodySync,
  onBodySync,
  onSelect,
  onChange,
}: {
  readonly root: TemplateItem;
  readonly edits: TemplateItemEdits;
  readonly selectedSourceId: string;
  readonly templateId: string;
  readonly operationId: string;
  readonly bodySync: CollabSync | null;
  readonly onBodySync: (sync: CollabSync | null) => void;
  readonly onSelect: (sourceId: string) => void;
  readonly onChange: (sourceId: string, edit: TemplateItemEdit) => void;
}): ReactNode {
  const items = flatten(root);
  const selected = items.find(({ item }) => item.sourceId === selectedSourceId)?.item ?? root;
  const edit = currentItem(selected, edits);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const previousSelectedSourceId = useRef(selected.sourceId);
  const itemNameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (previousSelectedSourceId.current === selected.sourceId) return;
    previousSelectedSourceId.current = selected.sourceId;
    itemNameRef.current?.focus();
  }, [selected.sourceId]);

  return (
    <section className="flex flex-col gap-5">
      <div>
        <Text variant="h2" as="h2">
          Edit the template contents
        </Text>
        <Text variant="bodySmall" tone="muted">
          Changes stay in a private draft until Save. Choose any included item to edit its title,
          fields, and views.
        </Text>
      </div>

      <div className="grid min-h-0 gap-4 md:grid-cols-[12rem_minmax(0,1fr)]">
        <nav aria-label="Items in this template" className="rounded-md bg-surface p-2">
          <Text variant="kicker" className="px-2 py-1">
            Template items
          </Text>
          <ul className="mt-1 flex flex-col gap-0.5">
            {items.map(({ item, depth }) => (
              <li key={item.sourceId}>
                <button
                  type="button"
                  disabled={item.sourceId === selected.sourceId}
                  aria-current={item.sourceId === selected.sourceId ? 'page' : undefined}
                  onClick={() => {
                    void (async () => {
                      try {
                        await bodySync?.flushAndWait();
                        setBodyError(null);
                        onSelect(item.sourceId);
                      } catch {
                        setBodyError(
                          'The current body has not finished saving. Keep this item open and try again.',
                        );
                      }
                    })();
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-sm py-1.5 pr-2 text-left',
                    depth === 0 ? 'pl-2' : depth === 1 ? 'pl-4' : depth === 2 ? 'pl-6' : 'pl-8',
                    item.sourceId === selected.sourceId
                      ? 'bg-accent/10 text-accent-text'
                      : 'hover:bg-foreground/7',
                    focusRing,
                  )}
                >
                  <Icon icon={FileText} size="sm" />
                  <span className="truncate">{currentItem(item, edits).title || 'Untitled'}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex min-w-0 flex-col gap-6">
          {bodyError === null ? null : (
            <Text variant="bodySmall" role="alert" className="rounded-md bg-surface px-3 py-2">
              {bodyError}
            </Text>
          )}
          <Field label="Item name">
            {(control) => (
              <Input
                {...control}
                ref={itemNameRef}
                value={edit.title}
                onChange={(event) => {
                  onChange(selected.sourceId, { ...edit, title: event.target.value });
                }}
              />
            )}
          </Field>

          <TemplateFieldsEditor
            edit={edit}
            onChange={(next) => {
              onChange(selected.sourceId, next);
            }}
          />

          <TemplateViewsEditor
            edit={edit}
            onChange={(next) => {
              onChange(selected.sourceId, next);
            }}
          />

          <TemplateBodyEditor
            key={selected.sourceId}
            item={selected}
            templateId={templateId}
            operationId={operationId}
            onSync={onBodySync}
          />
        </div>
      </div>
    </section>
  );
}

function TemplateBodyEditor({
  item,
  templateId,
  operationId,
  onSync,
}: {
  readonly item: TemplateItem;
  readonly templateId: string;
  readonly operationId: string;
  readonly onSync: (sync: CollabSync | null) => void;
}): ReactNode {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <Text variant="h3" as="h3">
          Body
        </Text>
        <Text variant="caption" tone="muted">
          Edit the starting content people receive with this item.
        </Text>
      </div>
      {!item.hasBody ? (
        <Text variant="bodySmall" tone="muted" className="rounded-md bg-surface p-3">
          Starting body content was not included when this template was captured.
        </Text>
      ) : (
        <div className="flex h-96 min-h-0 overflow-hidden rounded-md bg-background">
          <TemplateBody
            item={item}
            documentPath={templateDraftDocumentPath(templateId, operationId, item.sourceId)}
            onSync={onSync}
          />
        </div>
      )}
    </section>
  );
}

function TemplateBody({
  item,
  documentPath,
  onSync,
}: {
  readonly item: TemplateItem;
  readonly documentPath: string;
  readonly onSync: (sync: CollabSync | null) => void;
}): ReactNode {
  if (item.itemType === 'canvas') {
    return (
      <Suspense
        fallback={
          <Text tone="muted" className="m-auto">
            Loading canvas…
          </Text>
        }
      >
        <TemplateCanvasEditor
          key={documentPath}
          itemId={item.sourceId}
          documentPath={documentPath}
          onSync={onSync}
        />
      </Suspense>
    );
  }
  if (item.itemType === 'spreadsheet') {
    return (
      <SheetEditor
        key={documentPath}
        itemId={item.sourceId}
        documentPath={documentPath}
        onSync={onSync}
      />
    );
  }
  return (
    <NoteEditor
      key={documentPath}
      itemId={item.sourceId}
      documentPath={documentPath}
      onSync={onSync}
    />
  );
}

function TemplateFieldsEditor({
  edit,
  onChange,
}: {
  readonly edit: TemplateItemEdit;
  readonly onChange: (edit: TemplateItemEdit) => void;
}): ReactNode {
  const fields = declaredFields(edit);
  return (
    <section className="flex flex-col gap-3">
      <div>
        <Text variant="h3" as="h3">
          Fields
        </Text>
        <Text variant="caption" tone="muted">
          These fields are available to every item created inside this one.
        </Text>
      </div>
      {fields.length === 0 ? (
        <Text variant="bodySmall" tone="muted" className="rounded-md bg-surface p-3">
          This item does not declare any fields.
        </Text>
      ) : null}
      {fields.map((field, index) => (
        <div key={field.key} className="flex flex-col gap-3 rounded-md bg-surface p-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <Field label="Field name" className="flex-1">
              {(control) => (
                <Input
                  {...control}
                  value={field.label}
                  onChange={(event) => {
                    onChange(
                      replaceDeclaredFields(
                        edit,
                        fields.map((entry, position) =>
                          position === index ? { ...entry, label: event.target.value } : entry,
                        ),
                      ),
                    );
                  }}
                />
              )}
            </Field>
            <Field label="Type" className="sm:w-48">
              {(control) => (
                <Select
                  {...control}
                  value={field.type}
                  onChange={(event) => {
                    const type = event.target.value;
                    onChange(
                      replaceDeclaredFields(
                        edit,
                        fields.map((entry, position) =>
                          position === index
                            ? {
                                ...entry,
                                type,
                                options:
                                  type === 'select' || type === 'multi_select' ? entry.options : [],
                              }
                            : entry,
                        ),
                      ),
                    );
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
              aria-label={`Remove ${field.label || 'field'}`}
              onClick={() => {
                onChange(
                  replaceDeclaredFields(
                    edit,
                    fields.filter((_, position) => position !== index),
                  ),
                );
              }}
            >
              <Icon icon={Trash2} size="sm" />
            </Button>
          </div>
          {field.type === 'select' || field.type === 'multi_select' ? (
            <Field label="Options" hint="One option per line.">
              {(control) => (
                <textarea
                  {...control}
                  rows={3}
                  value={field.options.join('\n')}
                  onChange={(event) => {
                    const options = event.target.value
                      .split('\n')
                      .map((value) => value.trim())
                      .filter(Boolean);
                    onChange(
                      replaceDeclaredFields(
                        edit,
                        fields.map((entry, position) =>
                          position === index ? { ...entry, options } : entry,
                        ),
                      ),
                    );
                  }}
                />
              )}
            </Field>
          ) : null}
          <label className="flex items-center gap-2 text-base">
            <input
              type="checkbox"
              checked={field.required}
              className={focusRing}
              onChange={(event) => {
                onChange(
                  replaceDeclaredFields(
                    edit,
                    fields.map((entry, position) =>
                      position === index ? { ...entry, required: event.target.checked } : entry,
                    ),
                  ),
                );
              }}
            />
            Required
          </label>
        </div>
      ))}
      <Button
        variant="secondary"
        className="self-start"
        onClick={() => {
          const number = fields.length + 1;
          onChange(
            replaceDeclaredFields(edit, [
              ...fields,
              {
                key: `field_${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`,
                label: `Field ${String(number)}`,
                type: 'text',
                options: [],
                required: false,
              },
            ]),
          );
        }}
      >
        <Icon icon={Plus} size="sm" /> Add field
      </Button>
    </section>
  );
}

function TemplateViewsEditor({
  edit,
  onChange,
}: {
  readonly edit: TemplateItemEdit;
  readonly onChange: (edit: TemplateItemEdit) => void;
}): ReactNode {
  const views = edit.views?.views ?? [];
  const defaultView = edit.views?.default ?? 'document';
  const [addingKind, setAddingKind] = useState<StructuredRecipeId>('list');

  function replaceViews(next: readonly View[], nextDefault = defaultView, nextEdit = edit): void {
    onChange({
      ...nextEdit,
      views: {
        views: next.map((view) => ({
          ...view,
          companionViewId: view.companionViewId ?? null,
          companionPlacement: view.companionPlacement ?? null,
          interactiveForm: view.interactiveForm ?? null,
        })),
        default: nextDefault,
      },
    });
  }

  return (
    <section className="flex flex-col gap-3">
      <div>
        <Text variant="h3" as="h3">
          Views
        </Text>
        <Text variant="caption" tone="muted">
          Rename, reorder, configure, or remove the views people receive from this template.
        </Text>
      </div>
      {views.length === 0 ? (
        <Text variant="bodySmall" tone="muted" className="rounded-md bg-surface p-3">
          This item opens on its document and has no child-item views.
        </Text>
      ) : null}
      {views.map((view, index) => (
        <TemplateViewCard
          key={view.id}
          view={view}
          fields={edit.schema?.properties ?? []}
          views={views}
          isDefault={view.id === defaultView}
          first={index === 0}
          last={index === views.length - 1}
          onChange={(next) => {
            replaceViews(views.map((entry, position) => (position === index ? next : entry)));
          }}
          onMakeDefault={() => {
            replaceViews(views, view.id);
          }}
          onMove={(by) => {
            replaceViews(move(views, index, by));
          }}
          onRemove={() => {
            const next = views
              .filter((_, position) => position !== index)
              .map((entry) =>
                entry.companionViewId === view.id
                  ? { ...entry, companionViewId: null, companionPlacement: null }
                  : entry,
              );
            replaceViews(next, defaultView === view.id ? (next[0]?.id ?? 'document') : defaultView);
          }}
        />
      ))}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Field
          label="New view type"
          hint="Required compatible fields are added when they are missing."
          className="sm:w-64"
        >
          {(control) => (
            <Select
              {...control}
              value={addingKind}
              onChange={(event) => {
                setAddingKind(event.target.value as StructuredRecipeId);
              }}
            >
              {STRUCTURED_RECIPES.map((recipe) => (
                <option key={recipe.id} value={recipe.id}>
                  {recipe.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button
          variant="secondary"
          onClick={() => {
            const prepared = prepareNewView(edit, addingKind);
            replaceViews(
              [...views, prepared.view],
              views.length === 0 ? prepared.view.id : defaultView,
              prepared.edit,
            );
          }}
        >
          <Icon icon={Plus} size="sm" /> Add view
        </Button>
      </div>
    </section>
  );
}

function TemplateViewCard({
  view,
  fields,
  views,
  isDefault,
  first,
  last,
  onChange,
  onMakeDefault,
  onMove,
  onRemove,
}: {
  readonly view: View;
  readonly fields: readonly PropertyDefinition[];
  readonly views: readonly View[];
  readonly isDefault: boolean;
  readonly first: boolean;
  readonly last: boolean;
  readonly onChange: (view: View) => void;
  readonly onMakeDefault: () => void;
  readonly onMove: (by: number) => void;
  readonly onRemove: () => void;
}): ReactNode {
  const descriptor = findViewKind(view.kind);
  const isCompanion = views.some((candidate) => candidate.companionViewId === view.id);
  const companionChoices = views.filter(
    (candidate) => candidate.id !== view.id && candidate.companionViewId === null,
  );
  return (
    <div className="flex flex-col gap-3 rounded-md bg-surface p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Field label="View name" className="min-w-0 flex-1">
          {(control) => (
            <Input
              {...control}
              value={view.name}
              onChange={(event) => {
                onChange({ ...view, name: event.target.value });
              }}
            />
          )}
        </Field>
        <Text variant="caption" tone="muted" className="pb-2">
          {descriptor?.label ?? view.kind}
        </Text>
        <Button variant="secondary" disabled={isDefault} onClick={onMakeDefault}>
          {isDefault ? 'Default view' : 'Make default'}
        </Button>
        <Button
          variant="icon"
          aria-label={`Move ${view.name} earlier`}
          disabled={first}
          onClick={() => {
            onMove(-1);
          }}
        >
          <Icon icon={ChevronUp} size="sm" />
        </Button>
        <Button
          variant="icon"
          aria-label={`Move ${view.name} later`}
          disabled={last}
          onClick={() => {
            onMove(1);
          }}
        >
          <Icon icon={ChevronDown} size="sm" />
        </Button>
        <Button variant="icon" aria-label={`Remove ${view.name}`} onClick={onRemove}>
          <Icon icon={Trash2} size="sm" />
        </Button>
      </div>

      <StructuredViewConfiguration view={view} fields={fields} onChange={onChange} />

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Companion view"
          hint={
            isCompanion
              ? 'This view is already used as a companion, so it cannot contain another view.'
              : 'Show one other configured view with this one.'
          }
        >
          {(control) => (
            <Select
              {...control}
              disabled={isCompanion}
              value={view.companionViewId ?? ''}
              onChange={(event) => {
                const value = event.target.value;
                onChange({
                  ...view,
                  companionViewId: value.length === 0 ? null : value,
                  companionPlacement:
                    value.length === 0 ? null : (view.companionPlacement ?? 'below'),
                });
              }}
            >
              <option value="">None</option>
              {companionChoices.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {view.companionViewId === null ? null : (
          <Field label="Companion placement">
            {(control) => (
              <Select
                {...control}
                value={view.companionPlacement ?? 'below'}
                onChange={(event) => {
                  onChange({
                    ...view,
                    companionPlacement: event.target.value as 'below' | 'beside',
                  });
                }}
              >
                <option value="below">Below</option>
                <option value="beside">Side by side</option>
              </Select>
            )}
          </Field>
        )}
      </div>
    </div>
  );
}
