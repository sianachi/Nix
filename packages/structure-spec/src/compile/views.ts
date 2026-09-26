import type { ViewSpec } from '../spec/view.js';
import { findSmartList } from '../vocabulary/smart-lists.js';
import type { StructureFilter, StructureProperty, StructureView } from '../types.js';
import { compileForm } from './forms.js';
import { resolveKey } from './resolve.js';

/**
 * The id a compiled view gets: its kind, then `kind-2`, `kind-3`... for a second view of the same
 * kind on the same item (architecture 2.3). An `interactive_form` view keeps the shorter `form` id,
 * matching `viewForRecipe` (`../vocabulary/recipes.js`), so a recipe-seeded form and a pet-compiled
 * one land on the same id shape.
 */
function nextViewId(kind: string, usedIds: ReadonlySet<string>): string {
  const base = kind === 'interactive_form' ? 'form' : kind;
  if (!usedIds.has(base)) {
    return base;
  }
  let suffix = 2;
  while (usedIds.has(`${base}-${suffix.toString()}`)) {
    suffix += 1;
  }
  return `${base}-${suffix.toString()}`;
}

/**
 * A query view's filters: the preset's filters (`../vocabulary/smart-lists.js`) when `preset` is
 * given, followed by the view spec's own explicit filters, each resolved to a property key. An
 * unrecognised preset id throws, the same way an unknown recipe does in `operations.ts` - `preset`
 * is a closed enum in `viewSpecSchema`, so reaching one `findSmartList` does not know is itself a
 * sign the two lists have drifted apart, not something to compile as an empty filter set.
 */
function compileFilters(
  spec: ViewSpec,
  effective: readonly StructureProperty[],
  addedKeys: ReadonlySet<string> | undefined,
): StructureFilter[] {
  const filters: StructureFilter[] = [];

  if (spec.preset !== undefined) {
    const preset = findSmartList(spec.preset);
    if (preset === null) {
      throw new Error(`Unknown query preset "${spec.preset}".`);
    }
    filters.push(...preset.filters.map((filter) => ({ ...filter })));
  }

  if (spec.filters !== undefined) {
    for (const filter of spec.filters) {
      filters.push({
        property: resolveKey(filter.field, effective, addedKeys),
        operator: filter.op,
        value: filter.value,
      });
    }
  }

  return filters;
}

/**
 * Compiles a `ViewSpec` into a `StructureView` against the schema this view will see once its
 * item's fields are in place (`effective` - already-merged inherited and declared properties, plus
 * any fields this same operation is adding). `usedIds` is shared and mutated across every view
 * compiled for the same item, so a second board on one item gets `board-2` rather than colliding
 * with the first.
 *
 * `addedKeys` names the properties this same operation is adding, so a `FieldRef` in the spec
 * resolves by label only against them and by exact key against everything else - architecture 2.3's
 * rule, carried from `resolveFieldRef` (`../spec/refs.js`) through `resolveKey` (`./resolve.js`).
 * Every production caller (`operations.ts`) passes it; it is optional so a direct test can resolve
 * by label against the whole schema it is given without first working out which of it is "new".
 */
export function compileView(
  spec: ViewSpec,
  effective: readonly StructureProperty[],
  usedIds: Set<string>,
  addedKeys?: ReadonlySet<string>,
): StructureView {
  const id = nextViewId(spec.kind, usedIds);
  usedIds.add(id);

  const groupByKey =
    spec.groupBy !== undefined ? resolveKey(spec.groupBy, effective, addedKeys) : null;
  const groupBySource =
    groupByKey !== null ? effective.find((property) => property.key === groupByKey) : undefined;

  const mode =
    spec.mode ?? (spec.kind === 'calendar' ? 'week' : spec.kind === 'timeline' ? 'month' : null);

  return {
    id,
    name: spec.name ?? id,
    kind: spec.kind,
    columns:
      spec.columns !== undefined
        ? spec.columns.map((ref) => resolveKey(ref, effective, addedKeys))
        : ['title', ...effective.map((property) => property.key)],
    groupBy: groupByKey,
    groupOrder:
      spec.groupOrder ?? (groupBySource?.options !== undefined ? [...groupBySource.options] : []),
    dateProperty: spec.date !== undefined ? resolveKey(spec.date, effective, addedKeys) : null,
    sortBy: spec.sortBy !== undefined ? resolveKey(spec.sortBy, effective, addedKeys) : null,
    sortDescending: spec.sortDescending ?? false,
    mode,
    coverProperty: spec.cover !== undefined ? resolveKey(spec.cover, effective, addedKeys) : null,
    endDateProperty:
      spec.endDate !== undefined ? resolveKey(spec.endDate, effective, addedKeys) : null,
    cardSize: spec.cardSize ?? (spec.kind === 'gallery' ? 'medium' : null),
    layout: null,
    filters: compileFilters(spec, effective, addedKeys),
    measure: spec.kind === 'chart' ? (spec.measure ?? 'count') : null,
    measureProperty:
      spec.measureField !== undefined ? resolveKey(spec.measureField, effective, addedKeys) : null,
    companionViewId: null,
    companionPlacement: null,
    interactiveForm:
      spec.kind === 'interactive_form' && spec.form !== undefined
        ? compileForm(spec.form, effective, addedKeys)
        : null,
  };
}
