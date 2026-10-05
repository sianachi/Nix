import type { EntriesSpec } from '../spec/operations.js';
import type { StructuredSpec, ViewSetupSpec } from '../spec/operations.js';
import { findStructuredRecipe, viewForRecipe } from '../vocabulary/recipes.js';
import { mergeProperties } from '../vocabulary/merge-properties.js';
import type { StructureProperty, StructureView } from '../types.js';
import { compileFields } from './fields.js';
import { compileView } from './views.js';
import type { Step } from './steps.js';

export interface CreateStructuredContext {
  parentId: string | null;
  title: string;
  /** The parent's effective schema - what `inherit: true` (the spec's default) folds fields into. */
  inheritedFields: readonly StructureProperty[];
}

/**
 * Compiles a `create_structured` call into the one `createStructuredItem` step that creates it.
 * `spec.fields` seeds the item's own properties when given; when it is empty, the recipe's own
 * starter properties are used instead (`STRUCTURED_RECIPES`, `../vocabulary/recipes.js`), so a bare
 * "make me a board" still gets a Status field. The same rule governs views: `spec.views` when
 * given, else the recipe's own default view (`viewForRecipe`).
 */
export function compileCreateStructured(
  spec: StructuredSpec,
  context: CreateStructuredContext,
): Step[] {
  const recipe = findStructuredRecipe(spec.recipe);
  if (recipe === null) {
    throw new Error(`Unknown recipe "${spec.recipe}".`);
  }

  // Rollup sources and view/form field references resolve only against the fields actually in
  // force for this item: `inherit: false` means the parent's fields never reach it, so they must
  // not be resolvable here either, even though `context.inheritedFields` still names them.
  const inheritedScope = spec.inherit ? context.inheritedFields : [];

  const usesRecipeSeed = spec.fields.length === 0;
  const compiledFields = usesRecipeSeed
    ? {
        properties: recipe.properties.map((property) => ({
          ...property,
          options: [...property.options],
        })),
        keys: new Map(recipe.properties.map((property) => [property.label, property.key])),
      }
    : compileFields(spec.fields, { existing: inheritedScope });

  const effective = spec.inherit
    ? mergeProperties(context.inheritedFields, compiledFields.properties)
    : compiledFields.properties;
  const addedKeys = new Set(compiledFields.properties.map((property) => property.key));

  const usedIds = new Set<string>();
  const viewSpecs = spec.views !== undefined && spec.views.length > 0 ? spec.views : undefined;
  const views: StructureView[] =
    viewSpecs !== undefined
      ? viewSpecs.map((viewSpec) => compileView(viewSpec, effective, usedIds, addedKeys))
      : [viewForRecipe(recipe, compiledFields.properties)];

  const declaredDefaultIndex = viewSpecs?.findIndex((viewSpec) => viewSpec.default === true) ?? -1;
  const defaultView = declaredDefaultIndex >= 0 ? views[declaredDefaultIndex] : views[0];
  if (defaultView === undefined) {
    throw new Error('A structured item always compiles at least one view.');
  }

  return [
    {
      kind: 'createStructuredItem',
      parentId: context.parentId,
      title: context.title,
      schema: { properties: compiledFields.properties, inherit: spec.inherit },
      views,
      defaultViewId: defaultView.id,
    },
  ];
}

export interface AddViewContext {
  itemId: string;
  existing: {
    declared: readonly StructureProperty[];
    effective: readonly StructureProperty[];
    views: readonly StructureView[];
  };
}

/**
 * Compiles an `add_view` call into the one `appendViewSetup` step that adds it. `spec.fields` are
 * compiled against the item's current effective schema, exactly as a rollup or a view's column
 * reference in the same call may point at one of them (architecture 2.3's `FieldRef` rule).
 * `makeDefault` is true only when one of the new views asks to be the default - `add_view` never
 * demotes an existing default by omission.
 */
export function compileAddView(spec: ViewSetupSpec, context: AddViewContext): Step[] {
  const compiledFields = compileFields(spec.fields ?? [], { existing: context.existing.effective });
  const effective = [...context.existing.effective, ...compiledFields.properties];
  const addedKeys = new Set(compiledFields.properties.map((property) => property.key));

  const usedIds = new Set<string>(context.existing.views.map((view) => view.id));
  const views = spec.views.map((viewSpec) => compileView(viewSpec, effective, usedIds, addedKeys));
  const makeDefault = spec.views.some((viewSpec) => viewSpec.default === true);

  return [
    {
      kind: 'appendViewSetup',
      itemId: context.itemId,
      properties: compiledFields.properties,
      views,
      makeDefault,
    },
  ];
}

export interface EntriesContext {
  parentId: string | null;
}

/**
 * Compiles a `create_entries` call into one `createItem` step per entry, each followed by an
 * `appendBody` step when the entry carries markdown (architecture 3.3's "`create_note` pattern").
 * A sample entry's title gets the `Sample: ` prefix here, at compile time, so the preview the card
 * renders already shows the title the item will actually have.
 *
 * `entry.values` is passed through as given rather than resolved against a schema: `create_entries`
 * adds entries to an item whose fields already exist, and unlike `compileFields`/`compileView` this
 * compiler has no schema in its context to resolve a label against - a caller wanting label
 * resolution here validates and resolves before calling, the same way `@nix/structure-spec/validate`
 * (task A.1c) checks entry values against the target's effective schema.
 */
export function compileEntries(spec: EntriesSpec, context: EntriesContext): Step[] {
  const steps: Step[] = [];

  spec.entries.forEach((entry, index) => {
    const nodeId = `entry-${index.toString()}`;
    const title = entry.sample === true ? `Sample: ${entry.title}` : entry.title;

    steps.push({
      kind: 'createItem',
      parentId: context.parentId,
      title,
      properties: entry.values ?? null,
      nodeId,
      ...(entry.sample !== undefined ? { sample: entry.sample } : {}),
    });

    if (entry.markdown !== undefined && entry.markdown.length > 0) {
      steps.push({ kind: 'appendBody', target: { nodeId }, markdown: entry.markdown });
    }
  });

  return steps;
}
