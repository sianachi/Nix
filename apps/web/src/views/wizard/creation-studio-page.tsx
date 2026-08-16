import {
  Blueprint,
  Button,
  Dialog,
  Field,
  Icon,
  Input,
  Select,
  Text,
  cn,
  fieldLabel,
  focusRing,
} from '@nix/ui';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  Eye,
  GripVertical,
  Plus,
  Trash2,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router';

import { browserSessionStorage } from '../../lib/browser-storage';
import type { ShellContext } from '../../shell/shell-context';
import type { PropertyDefinition, View } from '../core/container-model';
import { PROPERTY_TYPES } from '../core/property-types';
import { FilterRulesEditor } from '../query/filter-rules-editor';
import { InteractiveFormEditor } from '../form/interactive-form-editor';
import { useContainer } from '../core/use-container';
import {
  SMART_LIST_STARTERS,
  findStructuredRecipe,
  keyForProperty,
  viewForRecipe,
  type StructuredRecipe,
  type StructuredRecipeId,
} from './structured-recipes';

interface StudioDraft {
  readonly title: string;
  readonly properties: readonly PropertyDefinition[];
  readonly view: View;
  readonly companionKind: 'list' | 'sheet' | 'board' | 'calendar' | 'gallery' | null;
  readonly companionViewId: string;
  readonly companionPlacement: 'below' | 'beside';
  readonly publish: boolean;
}

const STEPS = [
  { id: 'basics', label: 'Basics', detail: 'Name and destination' },
  { id: 'setup', label: 'Set up', detail: 'Fields and behaviour' },
  { id: 'companion', label: 'Companion', detail: 'An optional second view' },
  { id: 'review', label: 'Review', detail: 'Preview and create' },
] as const;

function requireStructuredRecipe(id: StructuredRecipeId): StructuredRecipe {
  const recipe = findStructuredRecipe(id);
  if (recipe === null) {
    throw new Error(`The ${id} creation recipe is required.`);
  }
  return recipe;
}

const FALLBACK_RECIPE: StructuredRecipe = requireStructuredRecipe('board');

function draftFor(recipe: StructuredRecipe): StudioDraft {
  const properties = recipe.properties.map((property) => ({
    ...property,
    options: [...property.options],
  }));
  const view = viewForRecipe(recipe, properties);
  return {
    title: recipe.defaultTitle,
    properties,
    view,
    companionKind: recipe.viewKind === 'interactive_form' ? 'list' : null,
    companionViewId: `${view.id}-companion`,
    companionPlacement: 'below',
    publish: false,
  };
}

function draftKey(recipe: StructuredRecipe, parentId: string | null): string {
  return `nix:create:${recipe.id}:${parentId ?? 'root'}`;
}

function uniqueIdentifier(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${String(suffix)}`)) suffix += 1;
  return `${base}-${String(suffix)}`;
}

function readDraft(recipe: StructuredRecipe, parentId: string | null): StudioDraft {
  const fallback = draftFor(recipe);
  const raw = browserSessionStorage()?.getItem(draftKey(recipe, parentId));
  if (raw === null || raw === undefined) return fallback;
  try {
    const parsed = JSON.parse(raw) as Partial<StudioDraft>;
    return parsed.title && parsed.view && Array.isArray(parsed.properties)
      ? {
          ...fallback,
          ...parsed,
          companionViewId: parsed.companionViewId ?? fallback.companionViewId,
        }
      : fallback;
  } catch {
    return fallback;
  }
}

function companionView(draft: StudioDraft): View | null {
  if (draft.companionKind === null) return null;
  const properties = draft.properties;
  const firstSelect = properties.find((property) => property.type === 'select');
  const firstDate = properties.find(
    (property) => property.type === 'date' || property.type === 'timestamp',
  );
  const firstImage = properties.find((property) => property.type === 'image');
  return {
    id: draft.companionViewId,
    name: draft.companionKind === 'sheet' ? 'Responses' : 'Companion',
    kind: draft.companionKind,
    columns: ['title', ...properties.map((property) => property.key)],
    groupBy: draft.companionKind === 'board' ? (firstSelect?.key ?? null) : null,
    groupOrder: draft.companionKind === 'board' ? [...(firstSelect?.options ?? [])] : [],
    dateProperty: draft.companionKind === 'calendar' ? (firstDate?.key ?? null) : null,
    sortBy: null,
    sortDescending: false,
    mode: draft.companionKind === 'calendar' ? 'week' : null,
    coverProperty: draft.companionKind === 'gallery' ? (firstImage?.key ?? null) : null,
    endDateProperty: null,
    cardSize: draft.companionKind === 'gallery' ? 'medium' : null,
    filters: [],
    companionViewId: null,
    companionPlacement: null,
    interactiveForm: null,
  };
}

function compiledViews(draft: StudioDraft): readonly View[] {
  const companion = companionView(draft);
  const primary = {
    ...draft.view,
    companionViewId: companion?.id ?? null,
    companionPlacement: companion === null ? null : draft.companionPlacement,
  };
  return companion === null ? [primary] : [primary, companion];
}

export function CreationStudioPage(): ReactNode {
  const { recipe, itemId, viewId } = useParams();
  const [searchParams] = useSearchParams();
  const scope = `${recipe ?? 'unknown'}:${itemId ?? 'new'}:${viewId ?? 'new'}:${searchParams.get('parent') ?? 'root'}`;
  return <CreationStudio key={scope} />;
}

function CreationStudio(): ReactNode {
  const { recipe: recipeId, itemId, viewId } = useParams();
  const recipe = findStructuredRecipe(recipeId);
  const [searchParams] = useSearchParams();
  const parentId = searchParams.get('parent');
  const draftScope = viewId === undefined ? (itemId ?? parentId) : `${itemId ?? 'item'}:${viewId}`;
  const { tree } = useOutletContext<ShellContext>();
  const targetContainer = useContainer(itemId ?? null);
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [discarding, setDiscarding] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<StudioDraft>(() =>
    recipe === null ? draftFor(FALLBACK_RECIPE) : readDraft(recipe, draftScope),
  );
  const seededEdit = useRef<string | null>(null);

  useEffect(() => {
    if (itemId === undefined || targetContainer.status !== 'ready') return;
    const activeRecipe = recipe ?? FALLBACK_RECIPE;
    const seedKey = viewId ?? `new:${itemId}`;
    if (seededEdit.current === seedKey) return;
    if (browserSessionStorage()?.getItem(draftKey(activeRecipe, draftScope)) != null) {
      seededEdit.current = seedKey;
      return;
    }

    const takenViewIds = new Set(targetContainer.views?.views.map((entry) => entry.id) ?? []);
    if (viewId === undefined) {
      const initial = draftFor(activeRecipe);
      const existingKeys = new Set(
        targetContainer.schema?.properties.map((property) => property.key) ?? [],
      );
      const properties = initial.properties.map((property) => {
        const key = uniqueIdentifier(property.key, existingKeys);
        existingKeys.add(key);
        return { ...property, key };
      });
      const view = viewForRecipe(activeRecipe, properties);
      const id = uniqueIdentifier(view.id, takenViewIds);
      takenViewIds.add(id);
      queueMicrotask(() => {
        seededEdit.current = seedKey;
        setDraft({
          ...initial,
          properties,
          view: { ...view, id },
          companionViewId: uniqueIdentifier(`${id}-companion`, takenViewIds),
        });
      });
      return;
    }

    const stored = targetContainer.views?.views.find((view) => view.id === viewId);
    if (stored === undefined) return;
    const companion = targetContainer.views?.views.find(
      (view) => view.id === stored.companionViewId,
    );
    const companionKind =
      companion?.kind === 'list' ||
      companion?.kind === 'sheet' ||
      companion?.kind === 'board' ||
      companion?.kind === 'calendar' ||
      companion?.kind === 'gallery'
        ? companion.kind
        : null;
    queueMicrotask(() => {
      seededEdit.current = seedKey;
      setDraft({
        title: stored.name,
        properties: targetContainer.schema?.declared ?? [],
        view: stored,
        companionKind,
        companionViewId: companion?.id ?? uniqueIdentifier(`${stored.id}-companion`, takenViewIds),
        companionPlacement: stored.companionPlacement ?? 'below',
        publish: false,
      });
    });
  }, [
    draftScope,
    itemId,
    recipe,
    targetContainer.schema,
    targetContainer.status,
    targetContainer.views,
    viewId,
  ]);

  useEffect(() => {
    if (recipe === null) return;
    // An existing-item studio starts with the recipe's placeholder while its container loads.
    // Persisting that placeholder would make the seeding effect mistake it for a recovered draft
    // and permanently hide the stored view configuration.
    if (itemId !== undefined && seededEdit.current === null) return;
    browserSessionStorage()?.setItem(draftKey(recipe, draftScope), JSON.stringify(draft));
  }, [draft, draftScope, itemId, recipe]);

  useEffect(() => {
    function warn(event: BeforeUnloadEvent): void {
      event.preventDefault();
    }
    globalThis.addEventListener('beforeunload', warn);
    return () => {
      globalThis.removeEventListener('beforeunload', warn);
    };
  }, []);

  if (recipe === null) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <Text variant="bodySmall" tone="muted">
          This guided setup is not available.
        </Text>
      </div>
    );
  }

  const destination =
    itemId !== undefined
      ? (tree.find(itemId)?.title ?? 'Current item')
      : parentId === null
        ? 'Workspace root'
        : (tree.find(parentId)?.title ?? 'Current item');
  const refusal = validateStep(step, draft);

  function updateView(change: Partial<View>): void {
    setDraft((current) => ({ ...current, view: { ...current.view, ...change } }));
  }

  async function finish(): Promise<void> {
    const finalRefusal = validateDraft(draft);
    if (finalRefusal !== null) {
      setError(finalRefusal);
      return;
    }
    setSaving(true);
    setError(null);
    if (itemId !== undefined) {
      const namedDraft = { ...draft, view: { ...draft.view, name: draft.title.trim() } };
      const reason =
        viewId === undefined
          ? await targetContainer.appendViewSetup(
              namedDraft.properties,
              compiledViews(namedDraft),
              true,
              namedDraft.publish && namedDraft.view.kind === 'interactive_form'
                ? namedDraft.view.id
                : null,
            )
          : await targetContainer.replaceViewSetup(
              viewId,
              namedDraft.properties,
              compiledViews(namedDraft),
              namedDraft.publish && namedDraft.view.kind === 'interactive_form'
                ? namedDraft.view.id
                : null,
            );
      setSaving(false);
      if (reason !== null) {
        setError(reason);
        return;
      }
      browserSessionStorage()?.removeItem(draftKey(recipe ?? FALLBACK_RECIPE, draftScope));
      const next = new URLSearchParams({ item: itemId, view: draft.view.id });
      void navigate(`/?${next.toString()}`);
      return;
    }

    const result = await tree.createStructured({
      parentId,
      title: draft.title.trim(),
      properties: draft.properties,
      views: compiledViews(draft),
      defaultView: draft.view.id,
      publishInteractiveFormViewId:
        draft.publish && draft.view.kind === 'interactive_form' ? draft.view.id : null,
    });
    setSaving(false);
    if (result.id === null) {
      setError(result.refusal);
      return;
    }
    browserSessionStorage()?.removeItem(draftKey(recipe ?? FALLBACK_RECIPE, draftScope));
    const next = new URLSearchParams({ item: result.id, view: draft.view.id });
    void navigate(`/?${next.toString()}`);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <header className="flex shrink-0 items-center gap-3 border-b border-divider px-4 py-3">
        <Button
          variant="icon"
          aria-label="Cancel guided setup"
          onClick={() => {
            setDiscarding(true);
          }}
        >
          <Icon icon={ArrowLeft} size="sm" />
        </Button>
        <div className="min-w-0 flex-1">
          <Text variant="h3" as="h1" className="truncate">
            {itemId === undefined
              ? `New ${recipe.label}`
              : viewId === undefined
                ? `Add ${recipe.label} view`
                : `Edit ${recipe.label}`}
          </Text>
          <Text variant="caption" tone="muted" className="truncate">
            Creating in {destination}
          </Text>
        </div>
        <Button
          variant="secondary"
          className="lg:hidden"
          onClick={() => {
            setPreviewing((current) => !current);
          }}
        >
          <Icon icon={Eye} size="sm" /> {previewing ? 'Hide preview' : 'Preview'}
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <nav
          aria-label="Creation steps"
          className="shrink-0 border-b border-divider bg-surface p-3 lg:w-44 lg:border-b-0 lg:border-r"
        >
          <ol className="grid grid-cols-4 gap-1 lg:flex lg:flex-col lg:gap-2">
            {STEPS.map((entry, index) => (
              <li key={entry.id}>
                <button
                  type="button"
                  aria-current={step === index ? 'step' : undefined}
                  onClick={() => {
                    setStep(index);
                  }}
                  className={cn(
                    `flex w-full items-center gap-2 rounded-md px-2 py-2 text-left ${focusRing}`,
                    step === index ? 'bg-accent/10 text-accent-text' : 'hover:bg-foreground/7',
                  )}
                >
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-background">
                    {index < step ? <Icon icon={Check} size="sm" /> : String(index + 1)}
                  </span>
                  <span className="hidden min-w-0 lg:block">
                    <Text variant="bodySmall" as="span" className="block">
                      {entry.label}
                    </Text>
                    <Text variant="caption" as="span" tone="muted" className="block truncate">
                      {entry.detail}
                    </Text>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </nav>

        <main
          className={cn(
            'min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-6',
            previewing ? 'hidden lg:block' : '',
          )}
        >
          <div className="mx-auto flex max-w-2xl flex-col gap-5">
            {step === 0 ? (
              <BasicsStep
                recipe={recipe}
                draft={draft}
                destination={destination}
                existingItem={itemId !== undefined}
                onChange={setDraft}
              />
            ) : step === 1 ? (
              <SetupStep
                draft={draft}
                existingProperties={targetContainer.schema?.properties ?? []}
                onChange={setDraft}
                updateView={updateView}
              />
            ) : step === 2 ? (
              <CompanionStep draft={draft} onChange={setDraft} />
            ) : (
              <ReviewStep draft={draft} destination={destination} />
            )}

            {error === null ? null : (
              <Text variant="bodySmall" role="alert" className="bg-surface px-3 py-2">
                {error}
              </Text>
            )}

            <div className="flex items-center justify-between border-t border-divider pt-4">
              <Button
                variant="secondary"
                disabled={step === 0 || saving}
                onClick={() => {
                  setStep((current) => Math.max(0, current - 1));
                }}
              >
                Back
              </Button>
              {step < STEPS.length - 1 ? (
                <Button
                  disabled={refusal !== null}
                  onClick={() => {
                    setStep((current) => Math.min(STEPS.length - 1, current + 1));
                  }}
                >
                  Continue <Icon icon={ArrowRight} size="sm" />
                </Button>
              ) : (
                <Button
                  disabled={saving || validateDraft(draft) !== null}
                  onClick={() => void finish()}
                >
                  {saving
                    ? itemId === undefined
                      ? 'Creating…'
                      : 'Adding…'
                    : itemId === undefined
                      ? `Create ${recipe.label}`
                      : viewId === undefined
                        ? `Add ${recipe.label}`
                        : 'Save changes'}
                </Button>
              )}
            </div>
          </div>
        </main>

        <aside
          aria-label="Live preview"
          className={cn(
            'min-h-0 overflow-y-auto border-l border-divider bg-surface p-4',
            'shrink-0 lg:w-80 xl:w-96',
            previewing ? 'block' : 'hidden lg:block',
          )}
        >
          <span className={fieldLabel}>Live preview</span>
          <StudioPreview draft={draft} />
        </aside>
      </div>

      <Dialog
        open={discarding}
        title="Discard this setup?"
        onClose={() => {
          setDiscarding(false);
        }}
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setDiscarding(false);
              }}
            >
              Keep editing
            </Button>
            <Button
              onClick={() => {
                browserSessionStorage()?.removeItem(draftKey(recipe, draftScope));
                void navigate(-1);
              }}
            >
              Discard setup
            </Button>
          </>
        }
      >
        <Text variant="bodySmall">
          The item has not been created yet. Discarding removes this tab&rsquo;s saved draft.
        </Text>
      </Dialog>
    </div>
  );
}

function BasicsStep({
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
      <div>
        <Text variant="h2" as="h2">
          {existingItem ? 'Name the view' : 'Name the setup'}
        </Text>
        <Text variant="bodySmall" tone="muted">
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
        <Text variant="note" tone="muted">
          Destination
        </Text>
        <Text variant="bodySmall">{destination}</Text>
      </Blueprint>
    </section>
  );
}

function SetupStep({
  draft,
  existingProperties,
  onChange,
  updateView,
}: {
  readonly draft: StudioDraft;
  readonly existingProperties: readonly PropertyDefinition[];
  readonly onChange: (draft: StudioDraft) => void;
  readonly updateView: (change: Partial<View>) => void;
}): ReactNode {
  return (
    <section className="flex flex-col gap-5">
      <div>
        <Text variant="h2" as="h2">
          Set up {draft.view.name}
        </Text>
        <Text variant="bodySmall" tone="muted">
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
      <ConfiguredPropertyChoice
        draft={draft}
        existingProperties={existingProperties}
        updateView={updateView}
      />
      {draft.view.kind === 'board' || draft.view.kind === 'list' || draft.view.kind === 'sheet' ? (
        <VisibleFieldsChoice
          draft={draft}
          existingProperties={existingProperties}
          updateView={updateView}
        />
      ) : null}
      {draft.view.kind === 'list' || draft.view.kind === 'sheet' ? (
        <SortChoice draft={draft} existingProperties={existingProperties} updateView={updateView} />
      ) : null}
      {draft.view.kind === 'calendar' ? (
        <Field label="Initial calendar view">
          {(control) => (
            <Select
              {...control}
              value={draft.view.mode ?? 'week'}
              onChange={(event) => {
                updateView({ mode: event.target.value });
              }}
            >
              <option value="day">Day</option>
              <option value="week">Week</option>
              <option value="month">Month</option>
            </Select>
          )}
        </Field>
      ) : null}
      {draft.view.kind === 'timeline' ? (
        <Field label="Initial time scale">
          {(control) => (
            <Select
              {...control}
              value={draft.view.mode ?? 'month'}
              onChange={(event) => {
                updateView({ mode: event.target.value });
              }}
            >
              <option value="week">Week</option>
              <option value="month">Month</option>
              <option value="quarter">Quarter</option>
            </Select>
          )}
        </Field>
      ) : null}
      {draft.view.kind === 'gallery' ? (
        <Field label="Card size">
          {(control) => (
            <Select
              {...control}
              value={draft.view.cardSize ?? 'medium'}
              onChange={(event) => {
                updateView({ cardSize: event.target.value });
              }}
            >
              <option value="small">Small</option>
              <option value="medium">Medium</option>
              <option value="large">Large</option>
            </Select>
          )}
        </Field>
      ) : null}
      {draft.view.kind === 'interactive_form' && draft.view.interactiveForm != null ? (
        <InteractiveFormEditor
          form={draft.view.interactiveForm}
          schema={[...existingProperties, ...draft.properties]}
          itemId={null}
          viewId={draft.view.id}
          showPublishing={false}
          onChange={(interactiveForm) => {
            updateView({ interactiveForm });
          }}
        />
      ) : null}
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

function ConfiguredPropertyChoice({
  draft,
  existingProperties,
  updateView,
}: {
  readonly draft: StudioDraft;
  readonly existingProperties: readonly PropertyDefinition[];
  readonly updateView: (change: Partial<View>) => void;
}): ReactNode {
  const all = [...existingProperties, ...draft.properties];
  if (draft.view.kind === 'board') {
    const usable = all.filter((property) => property.type === 'select');
    return (
      <Field label="Columns field" hint="Reuse a compatible field or create one above.">
        {(control) => (
          <Select
            {...control}
            value={draft.view.groupBy ?? ''}
            onChange={(event) => {
              const property = usable.find((entry) => entry.key === event.target.value);
              updateView({
                groupBy: property?.key ?? null,
                groupOrder: [...(property?.options ?? [])],
              });
            }}
          >
            <option value="">Choose a select field</option>
            {usable.map((property) => (
              <option key={property.key} value={property.key}>
                {property.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
    );
  }

  if (draft.view.kind === 'calendar' || draft.view.kind === 'timeline') {
    const usable = all.filter(
      (property) => property.type === 'date' || property.type === 'timestamp',
    );
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={draft.view.kind === 'timeline' ? 'Starts on' : 'Date field'}>
          {(control) => (
            <Select
              {...control}
              value={draft.view.dateProperty ?? ''}
              onChange={(event) => {
                const value = event.target.value;
                updateView({ dateProperty: value.length === 0 ? null : value });
              }}
            >
              <option value="">Choose a date field</option>
              {usable.map((property) => (
                <option key={property.key} value={property.key}>
                  {property.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {draft.view.kind === 'timeline' ? (
          <Field label="Ends on">
            {(control) => (
              <Select
                {...control}
                value={draft.view.endDateProperty ?? ''}
                onChange={(event) => {
                  const value = event.target.value;
                  updateView({ endDateProperty: value.length === 0 ? null : value });
                }}
              >
                <option value="">None</option>
                {usable.map((property) => (
                  <option key={property.key} value={property.key}>
                    {property.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
      </div>
    );
  }

  if (draft.view.kind === 'gallery') {
    const usable = all.filter((property) => property.type === 'image');
    return (
      <Field label="Cover field">
        {(control) => (
          <Select
            {...control}
            value={draft.view.coverProperty ?? ''}
            onChange={(event) => {
              const value = event.target.value;
              updateView({ coverProperty: value.length === 0 ? null : value });
            }}
          >
            <option value="">No cover</option>
            {usable.map((property) => (
              <option key={property.key} value={property.key}>
                {property.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
    );
  }

  return null;
}

function VisibleFieldsChoice({
  draft,
  existingProperties,
  updateView,
}: {
  readonly draft: StudioDraft;
  readonly existingProperties: readonly PropertyDefinition[];
  readonly updateView: (change: Partial<View>) => void;
}): ReactNode {
  const available = [...existingProperties, ...draft.properties].filter(
    (property, index, all) => all.findIndex((entry) => entry.key === property.key) === index,
  );
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className={fieldLabel}>Visible fields</legend>
      <label className="flex items-center gap-2 text-base">
        <input type="checkbox" checked disabled className={focusRing} />
        Title
      </label>
      {available.map((property) => {
        const checked = draft.view.columns.includes(property.key);
        return (
          <label key={property.key} className="flex items-center gap-2 text-base">
            <input
              type="checkbox"
              checked={checked}
              className={focusRing}
              onChange={(event) => {
                updateView({
                  columns: event.target.checked
                    ? [...draft.view.columns, property.key]
                    : draft.view.columns.filter((key) => key !== property.key),
                });
              }}
            />
            {property.label}
          </label>
        );
      })}
    </fieldset>
  );
}

function SortChoice({
  draft,
  existingProperties,
  updateView,
}: {
  readonly draft: StudioDraft;
  readonly existingProperties: readonly PropertyDefinition[];
  readonly updateView: (change: Partial<View>) => void;
}): ReactNode {
  const available = [...existingProperties, ...draft.properties].filter(
    (property, index, all) => all.findIndex((entry) => entry.key === property.key) === index,
  );
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Sort by">
        {(control) => (
          <Select
            {...control}
            value={draft.view.sortBy ?? ''}
            onChange={(event) => {
              const value = event.target.value;
              updateView({ sortBy: value.length === 0 ? null : value });
            }}
          >
            <option value="">No sorting</option>
            <option value="title">Title</option>
            {available.map((property) => (
              <option key={property.key} value={property.key}>
                {property.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <label className="flex items-center gap-2 self-end py-2 text-base">
        <input
          type="checkbox"
          className={focusRing}
          checked={draft.view.sortDescending}
          disabled={draft.view.sortBy === null}
          onChange={(event) => {
            updateView({ sortDescending: event.target.checked });
          }}
        />
        Descending order
      </label>
    </div>
  );
}

function FieldsEditor({
  properties,
  onChange,
}: {
  readonly properties: readonly PropertyDefinition[];
  readonly onChange: (properties: readonly PropertyDefinition[]) => void;
}): ReactNode {
  return (
    <div className="flex flex-col gap-3">
      {properties.map((property, index) => (
        <div
          key={`${property.key}-${String(index)}`}
          className="flex flex-col gap-3 rounded-md bg-surface p-3"
        >
          <div className="flex items-end gap-2">
            <Icon icon={GripVertical} size="sm" />
            <Field label="Field name" className="flex-1">
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
            <Field label="Type" className="w-48">
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
                <textarea
                  {...control}
                  rows={3}
                  value={property.options.join('\n')}
                  onChange={(event) => {
                    onChange(
                      properties.map((entry, position) =>
                        position === index
                          ? {
                              ...entry,
                              options: event.target.value
                                .split('\n')
                                .map((value) => value.trim())
                                .filter(Boolean),
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

function CompanionStep({
  draft,
  onChange,
}: {
  readonly draft: StudioDraft;
  readonly onChange: (draft: StudioDraft) => void;
}): ReactNode {
  const hasSelect = draft.properties.some((property) => property.type === 'select');
  const hasDate = draft.properties.some(
    (property) => property.type === 'date' || property.type === 'timestamp',
  );
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
              onChange({
                ...draft,
                companionKind: (event.target.value.length === 0
                  ? null
                  : event.target.value) as StudioDraft['companionKind'],
              });
            }}
          >
            <option value="">None</option>
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

function ReviewStep({
  draft,
  destination,
}: {
  readonly draft: StudioDraft;
  readonly destination: string;
}): ReactNode {
  return (
    <section className="flex flex-col gap-4">
      <div>
        <Text variant="h2" as="h2">
          Ready to create
        </Text>
        <Text variant="bodySmall" tone="muted">
          Nothing is written until you press Create.
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

function StudioPreview({ draft }: { readonly draft: StudioDraft }): ReactNode {
  const form = draft.view.interactiveForm;
  return (
    <Blueprint className="mt-3 flex flex-col gap-4 p-4">
      <div>
        <Text variant="h3" as="h2">
          {draft.title || 'Untitled'}
        </Text>
        <Text variant="note" tone="muted">
          {draft.view.name}
        </Text>
      </div>
      {form === null || form === undefined ? (
        <div className="flex flex-col gap-2">
          {draft.properties.length === 0 ? (
            <Text variant="bodySmall" tone="muted">
              Rules will determine which items appear.
            </Text>
          ) : (
            draft.properties.map((property) => (
              <div key={property.key} className="rounded-md bg-background px-3 py-2">
                <Text variant="caption" tone="muted">
                  {property.label}
                </Text>
                <Text variant="bodySmall">
                  {property.type === 'select'
                    ? property.options.join(' · ') || 'Add options'
                    : 'Example value'}
                </Text>
              </div>
            ))
          )}
        </div>
      ) : (
        form.pages.map((page, index) => (
          <section
            key={page.id}
            className={cn('flex flex-col gap-3', index > 0 && 'border-t border-divider pt-3')}
          >
            <Text variant="caption" tone="muted">
              Page {String(index + 1)}
            </Text>
            <Text variant="h4" as="h3">
              {page.title}
            </Text>
            {page.blocks.map((block) => (
              <div key={block.id}>
                {block.kind === 'field' ? (
                  <Field label={`${block.text}${block.required ? ' (required)' : ''}`}>
                    {(control) => (
                      <Input {...control} disabled placeholder={block.help ?? 'Response'} />
                    )}
                  </Field>
                ) : (
                  <Text
                    variant={block.kind === 'heading' ? 'body' : 'bodySmall'}
                    {...(block.kind === 'paragraph' ? { tone: 'muted' as const } : {})}
                  >
                    {block.text}
                  </Text>
                )}
              </div>
            ))}
          </section>
        ))
      )}
    </Blueprint>
  );
}

function refreshViewProperties(view: View, properties: readonly PropertyDefinition[]): View {
  const select = properties.find((property) => property.type === 'select');
  const dates = properties.filter(
    (property) => property.type === 'date' || property.type === 'timestamp',
  );
  const image = properties.find((property) => property.type === 'image');
  return {
    ...view,
    columns: ['title', ...properties.map((property) => property.key)],
    groupBy: view.kind === 'board' ? (select?.key ?? null) : view.groupBy,
    groupOrder: view.kind === 'board' ? [...(select?.options ?? [])] : view.groupOrder,
    dateProperty:
      view.kind === 'calendar' || view.kind === 'timeline'
        ? (dates[0]?.key ?? null)
        : view.dateProperty,
    endDateProperty: view.kind === 'timeline' ? (dates[1]?.key ?? null) : view.endDateProperty,
    coverProperty: view.kind === 'gallery' ? (image?.key ?? null) : view.coverProperty,
  };
}

function validateStep(step: number, draft: StudioDraft): string | null {
  if (step === 0 && draft.title.trim().length === 0) return 'Enter a name.';
  if (step === 1) return validateDraft(draft);
  return null;
}

function validateDraft(draft: StudioDraft): string | null {
  if (draft.title.trim().length === 0) return 'Enter a name.';
  const keys = new Set<string>();
  for (const property of draft.properties) {
    if (property.key.length === 0 || property.label.trim().length === 0)
      return 'Every field needs a name.';
    if (keys.has(property.key))
      return `More than one field uses “${property.label}”. Give each field a distinct name.`;
    keys.add(property.key);
    if (
      (property.type === 'select' || property.type === 'multi_select') &&
      property.options.length === 0
    )
      return `${property.label} needs at least one option.`;
  }
  if (draft.view.kind === 'board' && draft.view.groupBy === null)
    return 'A board needs a select field for its columns.';
  if (
    (draft.view.kind === 'calendar' || draft.view.kind === 'timeline') &&
    draft.view.dateProperty === null
  )
    return `${draft.view.name} needs a date field.`;
  if (
    draft.view.kind === 'interactive_form' &&
    (draft.view.interactiveForm?.pages.length ?? 0) === 0
  )
    return 'An interactive form needs at least one page.';
  const companion = companionView(draft);
  if (companion?.kind === 'board' && companion.groupBy === null)
    return 'Add a select field before using a Board companion.';
  if (companion?.kind === 'calendar' && companion.dateProperty === null)
    return 'Add a date field before using a Calendar companion.';
  return null;
}
