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
import { PRINT_PALETTE } from '@nix/design-tokens/print';
import { renderView } from '@nix/view-render';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router';
import { z } from 'zod';

import { browserSessionStorage } from '../../lib/browser-storage';
import type { ShellContext } from '../../shell/shell-context';
import { useWorkspace } from '../../workspaces/workspace-context';
import {
  PropertyDefinitionSchema,
  ViewSchema,
  type PropertyDefinition,
  type View,
} from '../core/container-model';
import { PROPERTY_TYPES, isDateShaped } from '../core/property-types';
import { StructuredViewConfiguration } from '../core/structured-view-configuration';
import { FilterRulesEditor } from '../query/filter-rules-editor';
import { InteractiveFormRespondentPreview } from '../form/interactive-form-editor';
import { validateInteractiveForm } from '../form/interactive-form-rules';
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
  readonly companionKind: string | null;
  readonly companionView: View | null;
  readonly companionViewId: string;
  readonly companionPlacement: 'below' | 'beside';
  readonly publish: boolean;
}

type StudioIntent = 'create' | 'add' | 'edit';

const StudioDraftSchema = z.object({
  title: z.string(),
  properties: z.array(PropertyDefinitionSchema),
  view: ViewSchema,
  companionKind: z.string().nullable(),
  companionView: ViewSchema.nullable().default(null),
  companionViewId: z.string(),
  companionPlacement: z.enum(['below', 'beside']),
  publish: z.boolean(),
});

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
  const companionViewId = `${view.id}-companion`;
  const companionKind = recipe.viewKind === 'interactive_form' ? 'list' : null;
  return {
    title: recipe.defaultTitle,
    properties,
    view,
    companionKind,
    companionView: null,
    companionViewId,
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
    const parsed = StudioDraftSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}

function createCompanionView(
  kind: string,
  id: string,
  properties: readonly PropertyDefinition[],
): View {
  const firstSelect = properties.find((property) => property.type === 'select');
  const firstDate = properties.find((property) => isDateShaped(property.type));
  const firstImage = properties.find((property) => property.type === 'image');
  return {
    id,
    name: kind === 'sheet' ? 'Responses' : 'Companion',
    kind,
    columns: ['title', ...properties.map((property) => property.key)],
    groupBy: kind === 'board' ? (firstSelect?.key ?? null) : null,
    groupOrder: kind === 'board' ? [...(firstSelect?.options ?? [])] : [],
    dateProperty: kind === 'calendar' || kind === 'timeline' ? (firstDate?.key ?? null) : null,
    sortBy: null,
    sortDescending: false,
    mode: kind === 'calendar' ? 'week' : kind === 'timeline' ? 'month' : null,
    coverProperty: kind === 'gallery' ? (firstImage?.key ?? null) : null,
    endDateProperty: null,
    cardSize: kind === 'gallery' ? 'medium' : null,
    filters: [],
    companionViewId: null,
    companionPlacement: null,
    interactiveForm: null,
  };
}

function companionView(draft: StudioDraft): View | null {
  if (draft.companionKind === null) return null;
  if (draft.companionView?.kind === draft.companionKind) return draft.companionView;
  return createCompanionView(draft.companionKind, draft.companionViewId, draft.properties);
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
  const { workspaceId } = useWorkspace();
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
  const stepMainRef = useRef<HTMLElement>(null);
  const previousStep = useRef(step);

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
      const companionViewId = uniqueIdentifier(`${id}-companion`, takenViewIds);
      queueMicrotask(() => {
        seededEdit.current = seedKey;
        setDraft({
          ...initial,
          properties,
          view: { ...view, id },
          companionView: null,
          companionViewId,
        });
      });
      return;
    }

    const stored = targetContainer.views?.views.find((view) => view.id === viewId);
    if (stored === undefined) return;
    const companion = targetContainer.views?.views.find(
      (view) => view.id === stored.companionViewId,
    );
    const companionKind = companion?.kind ?? null;
    queueMicrotask(() => {
      seededEdit.current = seedKey;
      setDraft({
        title: stored.name,
        properties: targetContainer.schema?.declared ?? [],
        view: stored,
        companionKind,
        companionView: companion ?? null,
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

  useEffect(() => {
    if (previousStep.current === step) return;
    previousStep.current = step;
    const heading = stepMainRef.current?.querySelector<HTMLElement>('h2');
    if (heading === null || heading === undefined) return;
    heading.tabIndex = -1;
    heading.focus();
  }, [step]);

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
  const intent: StudioIntent =
    itemId === undefined ? 'create' : viewId === undefined ? 'add' : 'edit';
  const existingProperties = targetContainer.schema?.properties ?? [];

  function focusFirstField(): void {
    queueMicrotask(() => {
      stepMainRef.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
    });
  }

  function goToStep(nextStep: number): void {
    if (nextStep <= step) {
      setError(null);
      setStep(nextStep);
      return;
    }

    for (let candidate = step; candidate < nextStep; candidate += 1) {
      const reason = validateStep(candidate, draft, existingProperties);
      if (reason !== null) {
        setStep(candidate);
        setError(reason);
        focusFirstField();
        return;
      }
    }

    setError(null);
    setStep(nextStep);
  }

  async function finish(): Promise<void> {
    const finalRefusal = validateDraft(draft, existingProperties);
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
      void navigate(`/w/${workspaceId}?${next.toString()}`);
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
    void navigate(`/w/${workspaceId}?${next.toString()}`);
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
            {itemId === undefined
              ? `Creating in ${destination}`
              : viewId === undefined
                ? `Adding to ${destination}`
                : `Editing in ${destination}`}
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
                  aria-label={`${entry.label}: ${entry.detail}`}
                  onClick={() => {
                    goToStep(index);
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
          ref={stepMainRef}
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
                existingProperties={existingProperties}
                onChange={setDraft}
              />
            ) : step === 2 ? (
              <CompanionStep draft={draft} onChange={setDraft} />
            ) : (
              <ReviewStep draft={draft} destination={destination} intent={intent} />
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
                  goToStep(Math.max(0, step - 1));
                }}
              >
                Back
              </Button>
              {step < STEPS.length - 1 ? (
                <Button
                  disabled={saving}
                  onClick={() => {
                    goToStep(Math.min(STEPS.length - 1, step + 1));
                  }}
                >
                  Continue <Icon icon={ArrowRight} size="sm" />
                </Button>
              ) : (
                <Button
                  disabled={saving || validateDraft(draft, existingProperties) !== null}
                  onClick={() => void finish()}
                >
                  {saving
                    ? intent === 'create'
                      ? 'Creating…'
                      : intent === 'add'
                        ? 'Adding…'
                        : 'Updating…'
                    : intent === 'create'
                      ? `Create ${recipe.label}`
                      : intent === 'add'
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
            'min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain border-t border-divider bg-surface p-4',
            'lg:flex-none lg:shrink-0 lg:border-l lg:border-t-0 lg:w-80 xl:w-96',
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
          {itemId === undefined
            ? 'The item has not been created yet.'
            : viewId === undefined
              ? 'The view has not been added yet.'
              : 'The existing view has not been changed yet.'}{' '}
          Discarding removes this tab&rsquo;s saved draft.
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
}: {
  readonly draft: StudioDraft;
  readonly existingProperties: readonly PropertyDefinition[];
  readonly onChange: (draft: StudioDraft) => void;
}): ReactNode {
  const fields = mergedFields(draft.properties, existingProperties);
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
  nearer: readonly PropertyDefinition[],
  farther: readonly PropertyDefinition[],
): readonly PropertyDefinition[] {
  const nearerKeys = new Set(nearer.map((field) => field.key));
  return [...nearer, ...farther.filter((field) => !nearerKeys.has(field.key))];
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

function ReviewStep({
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

function StudioPreview({ draft }: { readonly draft: StudioDraft }): ReactNode {
  const form = draft.view.interactiveForm;
  if (form !== null && form !== undefined) {
    return (
      <div className="mt-3">
        <InteractiveFormRespondentPreview form={form} schema={draft.properties} />
      </div>
    );
  }

  const rows = Array.from({ length: 6 }, (_unused, index) => ({
    id: `preview-${String(index + 1)}`,
    title: `Example ${String(index + 1)}`,
    properties: Object.fromEntries(
      draft.properties.map((property) => [property.key, previewValue(property, index)]),
    ),
  }));
  const view = {
    ...draft.view,
    companionViewId: draft.view.companionViewId ?? null,
    companionPlacement: draft.view.companionPlacement ?? null,
    interactiveForm: null,
  };
  const rendered = renderView({
    view,
    rows,
    schema: { properties: draft.properties, declared: draft.properties, inherit: false },
    palette: PRINT_PALETTE,
    width: 360,
  });
  const source = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(rendered.svg)}`;
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
      <img
        src={source}
        alt={`${draft.view.name} live preview`}
        className="h-auto w-full rounded-md bg-background"
      />
      {rendered.notes.length === 0 ? null : (
        <Text variant="caption" tone="muted">
          {rendered.notes.join(' ')}
        </Text>
      )}
    </Blueprint>
  );
}

function previewValue(property: PropertyDefinition, index: number): unknown {
  if (property.type === 'checkbox') return index % 2 === 0;
  if (property.type === 'number') return index + 1;
  if (isDateShaped(property.type)) return `2026-08-${String(index + 10).padStart(2, '0')}`;
  if (property.type === 'multi_select') return property.options.slice(0, 2);
  if (property.type === 'select')
    return property.options[index % Math.max(1, property.options.length)] ?? '';
  return `${property.label} ${String(index + 1)}`;
}

function refreshViewProperties(view: View, properties: readonly PropertyDefinition[]): View {
  const select = properties.find((property) => property.type === 'select');
  const dates = properties.filter((property) => isDateShaped(property.type));
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

function validateStep(
  step: number,
  draft: StudioDraft,
  existingProperties: readonly PropertyDefinition[] = [],
): string | null {
  if (step === 0 && draft.title.trim().length === 0) return 'Enter a name.';
  if (step === 1) return validateDraft(draft, existingProperties);
  return null;
}

function validateDraft(
  draft: StudioDraft,
  existingProperties: readonly PropertyDefinition[] = [],
): string | null {
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
  if (draft.view.kind === 'interactive_form') {
    if (draft.view.interactiveForm === null || draft.view.interactiveForm === undefined)
      return 'An interactive form needs a form definition.';
    const formRefusal = validateInteractiveForm(draft.view.interactiveForm, [
      ...existingProperties,
      ...draft.properties,
    ]);
    if (formRefusal !== null) return formRefusal;
  }
  const companion = companionView(draft);
  if (companion?.kind === 'board' && companion.groupBy === null)
    return 'Add a select field before using a Board companion.';
  if (companion?.kind === 'calendar' && companion.dateProperty === null)
    return 'Add a date field before using a Calendar companion.';
  return null;
}
