import { isTitleColumnReference, type ViewSpec } from '../spec/view.js';
import { TYPE_GROUP_KEY } from '../vocabulary/property-types.js';
import { findSmartList } from '../vocabulary/smart-lists.js';
import type {
  StructureChartOptions,
  StructureFilter,
  StructureFilterEntry,
  StructureProperty,
  StructureView,
} from '../types.js';
import { isDateShaped } from '../vocabulary/property-types.js';
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
): StructureFilterEntry[] {
  const filters: StructureFilterEntry[] = [];

  if (spec.preset !== undefined) {
    const preset = findSmartList(spec.preset);
    if (preset === null) {
      throw new Error(`Unknown query preset "${spec.preset}".`);
    }
    filters.push(...preset.filters.map((filter) => ({ ...filter })));
  }

  const condition = (filter: { field: string; op: string; value: string }): StructureFilter => ({
    // A structural field (`$type`, `$inside`, ...) is a fact about the item, not a property, so
    // it is never resolved against the schema; Core polices which ones exist.
    property: isStructuralField(filter.field)
      ? filter.field
      : resolveKey(filter.field, effective, addedKeys),
    operator: filter.op,
    value: filter.value,
  });

  if (spec.filters !== undefined) {
    for (const filter of spec.filters) {
      filters.push(condition(filter));
    }
  }

  return filters;
}

/** Whether a filter field names a structural query field rather than a property. */
export function isStructuralField(field: string): boolean {
  return field.startsWith('$');
}

/**
 * A chart view's options, or null when the spec asks for nothing beyond a bar chart of categories.
 *
 * A chart grouped by a date-shaped property is put on a time axis even when the spec names no
 * period - month, the grain a person most often means by "over time" - because a chart bucketing
 * raw dates would draw one bar per distinct day. Line, area and the year grid are the time-axis
 * types; the year grid always counts by day, which is what Core insists on too.
 */
export function compileChartOptions(
  spec: Pick<ViewSpec, 'kind' | 'chartKind' | 'period'>,
  groupByType: string | undefined,
  splitBy: string | null,
): StructureChartOptions | null {
  if (spec.kind !== 'chart') {
    return null;
  }

  const dated = groupByType !== undefined && isDateShaped(groupByType);
  const period = spec.chartKind === 'year' ? 'day' : (spec.period ?? (dated ? 'month' : null));
  const kind = spec.chartKind ?? null;

  if (kind === null && period === null && splitBy === null) {
    return null;
  }

  return {
    kind,
    period,
    splitBy,
    lastPeriods: null,
    from: null,
    to: null,
    cumulative: null,
    rollingAverage: null,
    stacked: null,
  };
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

  // `$type` is the one grouping key that is not a property - a list sectioned by body kind - so it
  // is carried through as written rather than resolved against the schema.
  //
  // A matrix's `columnBy` is stored as `groupBy`, the board's own field, so a board switched to a
  // matrix keeps its columns; its rows are the matrix's own `rowBy`.
  const groupByRef = spec.kind === 'matrix' ? spec.columnBy : spec.groupBy;
  const groupByKey =
    groupByRef === undefined
      ? null
      : groupByRef === TYPE_GROUP_KEY
        ? TYPE_GROUP_KEY
        : resolveKey(groupByRef, effective, addedKeys);
  const groupBySource =
    groupByKey !== null ? effective.find((property) => property.key === groupByKey) : undefined;

  const mode =
    spec.mode ?? (spec.kind === 'calendar' ? 'week' : spec.kind === 'timeline' ? 'month' : null);

  return {
    id,
    name: spec.name ?? id,
    kind: spec.kind,
    // A checklist's columns name the one property each line shows beside its title, so it takes
    // none by default rather than every property the schema has.
    columns:
      spec.columns !== undefined
        ? spec.columns.map((ref) =>
            isTitleColumnReference(spec.kind, ref) ? ref : resolveKey(ref, effective, addedKeys),
          )
        : spec.kind === 'checklist'
          ? []
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
    chart: compileChartOptions(
      spec,
      groupBySource?.type,
      spec.splitBy !== undefined ? resolveKey(spec.splitBy, effective, addedKeys) : null,
    ),
    companionViewId: null,
    companionPlacement: null,
    interactiveForm:
      spec.kind === 'interactive_form' && spec.form !== undefined
        ? compileForm(spec.form, effective, addedKeys)
        : null,
    doneProperty:
      spec.doneProperty !== undefined ? resolveKey(spec.doneProperty, effective, addedKeys) : null,
    rowBy: spec.rowBy !== undefined ? resolveKey(spec.rowBy, effective, addedKeys) : null,
  };
}
