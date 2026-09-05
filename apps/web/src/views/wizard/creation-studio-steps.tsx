import { Blueprint, Button, Field, Icon, Input, Select, Text, focusRing } from '@nix/ui';
import { ChevronDown, ChevronUp, GripVertical, Plus, Trash2 } from 'lucide-react';
import { type ReactNode } from 'react';

import type { PropertyDefinition as PropertyDefinitionType } from '../core/container-model';
import { LineListInput } from '../core/line-list-input';
import { PROPERTY_TYPES, isDateShaped } from '../core/property-types';
import { StructuredViewConfiguration } from '../core/structured-view-configuration';
import { FilterRulesEditor } from '../query/filter-rules-editor';
import {
  companionView,
  refreshViewProperties,
  type StudioDraft,
  type StudioIntent,
} from './creation-studio-model';
import { SMART_LIST_STARTERS, keyForProperty, type StructuredRecipe } from './structured-recipes';

export function BasicsStep({
  recipe,
  draft,
  destination,
  existingItem,
  onChange,
}: {
  readonly recipe: StructuredRecipe;
  readonly draft: StudioDraft;
  readonly destination: string;
  readonly existingItem: boolean;
  readonly onChange: (draft: StudioDraft) => void;
}): ReactNode {
  return (
    <section className="flex flex-col gap-4">
      <div className="max-w-prose">
        <Text variant="h2" as="h2">
          {existingItem ? 'Name the view' : 'Name the setup'}
        </Text>
        <Text variant="note" tone="muted" className="mt-1">
          {recipe.detail}
        </Text>
      </div>
      <Field label="Name" hint="You can rename it later without changing shared links.">
        {(control) => (
          <Input
            {...control}
            value={draft.title}
            onChange={(event) => {
              onChange({ ...draft, title: event.target.value });
            }}
          />
        )}
      </Field>
      <Blueprint className="p-4">
        <Text variant="caption" tone="muted">
          Destination
        </Text>
        <Text variant="body">{destination}</Text>
      </Blueprint>
    </section>
  );
}

export function SetupStep({
  draft,
  existingProperties,
  onChange,
}: {
  readonly draft: StudioDraft;
  readonly existingProperties: readonly PropertyDefinitionType[];
  readonly onChange: (draft: StudioDraft) => void;
}): ReactNode {
  const fields = mergedFields(draft.properties, existingProperties);
  return (
    <section className="flex flex-col gap-5">
      <div className="max-w-prose">
        <Text variant="h2" as="h2">
          Set up {draft.view.name}
        </Text>
        <Text variant="note" tone="muted" className="mt-1">
          Fields are shared by this view and every companion.
        </Text>
      </div>
      {draft.view.kind === 'query' ? (
        <SmartListSetup draft={draft} onChange={onChange} />
      ) : (
        <FieldsEditor
          properties={draft.properties}
          onChange={(properties) => {
            const refreshed = refreshViewProperties(draft.view, properties);
            onChange({ ...draft, properties, view: refreshed });
          }}
        />
      )}
      {draft.view.kind === 'query' ? null : (
        <StructuredViewConfiguration
          view={draft.view}
          fields={fields}
          showColumns={['board', 'list', 'sheet'].includes(draft.view.kind)}
          showSortAndFilters={['list', 'sheet'].includes(draft.view.kind)}
          showKindFilters={false}
          onChange={(view) => {
            onChange({ ...draft, view });
          }}
        />
      )}
      {draft.view.kind === 'interactive_form' ? (
        <label className="flex items-center gap-2 text-base">
          <input
            type="checkbox"
            checked={draft.publish}
            onChange={(event) => {
              onChange({ ...draft, publish: event.target.checked });
            }}
            className={focusRing}
          />
          Publish a public response link when this form is created
        </label>
      ) : null}
    </section>
  );
}

function mergedFields(
  nearer: readonly PropertyDefinitionType[],
  farther: readonly PropertyDefinitionType[],
): readonly PropertyDefinitionType[] {
  const nearerKeys = new Set(nearer.map((field) => field.key));
  return [...nearer, ...farther.filter((field) => !nearerKeys.has(field.key))];
}

function FieldsEditor({
  properties,
  onChange,
}: {
  readonly properties: readonly PropertyDefinitionType[];
  readonly onChange: (properties: readonly PropertyDefinitionType[]) => void;
}): ReactNode {
  return (
    <div className="flex flex-col gap-3">
      {properties.map((property, index) => (
        <div key={index} className="flex flex-col gap-3 rounded-md bg-surface p-3">
          <div className="flex flex-wrap items-end gap-2">
            <Icon icon={GripVertical} size="sm" />
            <Field label="Field name" className="min-w-full sm:min-w-0 sm:flex-1">
              {(control) => (
                <Input
                  {...control}
                  value={property.label}
                  onChange={(event) => {
                    const label = event.target.value;
                    onChange(
                      properties.map((entry, position) =>
                        position === index
                          ? { ...entry, label, key: keyForProperty(label) }
                          : entry,
                      ),
                    );
                  }}
                />
              )}
            </Field>
            <Field label="Type" className="min-w-0 flex-1 sm:w-48 sm:flex-none">
              {(control) => (
                <Select
                  {...control}
                  value={property.type}
                  onChange={(event) => {
                    onChange(
                      properties.map((entry, position) =>
                        position === index
                          ? {
                              ...entry,
                              type: event.target.value,
                              options:
                                event.target.value === 'select' ||
                                event.target.value === 'multi_select'
                                  ? entry.options
                                  : [],
                            }
                          : entry,
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
              aria-label={`Move ${property.label || 'field'} earlier`}
              disabled={index === 0}
              onClick={() => {
                const next = [...properties];
                const previous = next[index - 1];
                if (previous === undefined) return;
                next[index - 1] = property;
                next[index] = previous;
                onChange(next);
              }}
            >
              <Icon icon={ChevronUp} size="sm" />
            </Button>
            <Button
              variant="icon"
              aria-label={`Move ${property.label || 'field'} later`}
              disabled={index === properties.length - 1}
              onClick={() => {
                const next = [...properties];
                const following = next[index + 1];
                if (following === undefined) return;
                next[index] = following;
                next[index + 1] = property;
                onChange(next);
              }}
            >
              <Icon icon={ChevronDown} size="sm" />
            </Button>
            <Button
              variant="icon"
              aria-label={`Remove ${property.label || 'field'}`}
              onClick={() => {
                onChange(properties.filter((_, position) => position !== index));
              }}
            >
              <Icon icon={Trash2} size="sm" />
            </Button>
          </div>
          {property.type === 'select' || property.type === 'multi_select' ? (
            <Field label="Options" hint="One option per line.">
              {(control) => (
                <LineListInput
                  {...control}
                  rows={3}
                  value={property.options}
                  onChange={(options) => {
                    onChange(
                      properties.map((entry, position) =>
                        position === index
                          ? {
                              ...entry,
                              options,
                            }
                          : entry,
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
              className={focusRing}
              checked={property.required}
              onChange={(event) => {
                onChange(
                  properties.map((entry, position) =>
                    position === index ? { ...entry, required: event.target.checked } : entry,
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
          onChange([
            ...properties,
            {
              key: `field_${String(properties.length + 1)}`,
              label: `Field ${String(properties.length + 1)}`,
              type: 'text',
              options: [],
              required: false,
            },
          ]);
        }}
      >
        <Icon icon={Plus} size="sm" />
        Add field
      </Button>
    </div>
  );
}

function SmartListSetup({
  draft,
  onChange,
}: {
  readonly draft: StudioDraft;
  readonly onChange: (draft: StudioDraft) => void;
}): ReactNode {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <Text variant="note" tone="muted">
          Start with
        </Text>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              onChange({ ...draft, view: { ...draft.view, filters: [] } });
            }}
          >
            Blank
          </Button>
          {SMART_LIST_STARTERS.map((starter) => (
            <Button
              key={starter.id}
              variant="secondary"
              onClick={() => {
                onChange({ ...draft, view: { ...draft.view, filters: [...starter.filters] } });
              }}
            >
              {starter.label}
            </Button>
          ))}
        </div>
      </div>
      <FilterRulesEditor
        rules={draft.view.filters}
        schema={draft.properties}
        onChange={(filters) => {
          onChange({ ...draft, view: { ...draft.view, filters: [...filters] } });
        }}
      />
    </div>
  );
}

export function CompanionStep({
  draft,
  onChange,
}: {
  readonly draft: StudioDraft;
  readonly onChange: (draft: StudioDraft) => void;
}): ReactNode {
  const hasSelect = draft.properties.some((property) => property.type === 'select');
  const hasDate = draft.properties.some((property) => isDateShaped(property.type));
  const offeredKinds = new Set(['list', 'sheet', 'board', 'calendar', 'gallery']);
  const configuredCompanion = companionView(draft);
  return (
    <section className="flex flex-col gap-4">
      <div>
        <Text variant="h2" as="h2">
          Add a companion view
        </Text>
        <Text variant="bodySmall" tone="muted">
          Both views use the same items. Their filters and sorting remain independent.
        </Text>
      </div>
      <Field label="Companion">
        {(control) => (
          <Select
            {...control}
            value={draft.companionKind ?? ''}
            onChange={(event) => {
              const companionKind = event.target.value.length === 0 ? null : event.target.value;
              onChange({
                ...draft,
                companionKind,
                companionView:
                  companionKind === null
                    ? null
                    : draft.companionView?.kind === companionKind
                      ? draft.companionView
                      : null,
              });
            }}
          >
            <option value="">None</option>
            {draft.companionKind !== null && !offeredKinds.has(draft.companionKind) ? (
              <option value={draft.companionKind}>
                {configuredCompanion?.name ?? draft.companionKind}
              </option>
            ) : null}
            <option value="list">List</option>
            <option value="sheet">Spreadsheet</option>
            <option value="board" disabled={!hasSelect}>
              Board
            </option>
            <option value="calendar" disabled={!hasDate}>
              Calendar
            </option>
            <option value="gallery">Gallery</option>
          </Select>
        )}
      </Field>
      {draft.companionKind === null ? null : (
        <Field label="Placement">
          {(control) => (
            <Select
              {...control}
              value={draft.companionPlacement}
              onChange={(event) => {
                onChange({
                  ...draft,
                  companionPlacement: event.target.value as StudioDraft['companionPlacement'],
                });
              }}
            >
              <option value="below">Below</option>
              <option value="beside">Side by side</option>
            </Select>
          )}
        </Field>
      )}
    </section>
  );
}

export function ReviewStep({
  draft,
  destination,
  intent,
}: {
  readonly draft: StudioDraft;
  readonly destination: string;
  readonly intent: StudioIntent;
}): ReactNode {
  return (
    <section className="flex flex-col gap-4">
      <div>
        <Text variant="h2" as="h2">
          {intent === 'create'
            ? 'Ready to create'
            : intent === 'add'
              ? 'Ready to add'
              : 'Ready to save'}
        </Text>
        <Text variant="bodySmall" tone="muted">
          {intent === 'create'
            ? 'Nothing is written until you press Create.'
            : intent === 'add'
              ? 'Nothing is added until you press Add.'
              : 'Nothing changes until you press Save.'}
        </Text>
      </div>
      <Blueprint className="grid gap-3 p-4 sm:grid-cols-2">
        <div>
          <Text variant="caption" tone="muted">
            Name
          </Text>
          <Text variant="bodySmall">{draft.title}</Text>
        </div>
        <div>
          <Text variant="caption" tone="muted">
            Destination
          </Text>
          <Text variant="bodySmall">{destination}</Text>
        </div>
        <div>
          <Text variant="caption" tone="muted">
            Fields
          </Text>
          <Text variant="bodySmall">{String(draft.properties.length)}</Text>
        </div>
        <div>
          <Text variant="caption" tone="muted">
            Layout
          </Text>
          <Text variant="bodySmall">
            {draft.companionKind === null
              ? 'One view'
              : `${draft.companionPlacement === 'beside' ? 'Side by side' : 'Stacked'} with ${draft.companionKind}`}
          </Text>
        </div>
      </Blueprint>
    </section>
  );
}
