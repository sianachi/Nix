import type {
  StructureFilter,
  StructureForm,
  StructureFormCondition,
  StructureHabitWidget,
  StructureProperty,
  StructureView,
} from '../types.js';
import { isComputedType, isDateShaped, valueShapeOf } from '../vocabulary/property-types.js';
import { isRealCalendarDay } from './values.js';

/** `ViewDefinitionsJson.MaximumViews` (`backend/src/Nix.Api/Domain/Views/ViewDefinitionsJson.cs:79`). */
const MAXIMUM_VIEWS = 12;
/** `ViewDefinitionsJson.DocumentView` - reserved for an item's own body, never a stored view. */
const RESERVED_VIEW_ID = 'document';
const CARD_SIZES: ReadonlySet<string> = new Set(['small', 'medium', 'large']);
const LAYOUTS: ReadonlySet<string> = new Set(['list', 'grid']);
const HABIT_WIDGET_KINDS: ReadonlySet<string> = new Set(['completion', 'quantity', 'heatmap']);
const MAXIMUM_HABIT_WIDGETS = 12;
const MAXIMUM_HABIT_RANGE_DAYS = 366;
const MILLISECONDS_PER_DAY = 86_400_000;

const KNOWN_FILTER_OPERATORS: ReadonlySet<string> = new Set([
  'equals',
  'not-equals',
  'on',
  'before',
  'on-or-after',
  'within-next',
]);
const DAY_FILTER_OPERATORS: ReadonlySet<string> = new Set(['on', 'before', 'on-or-after']);
const KNOWN_CONDITION_OPERATORS: ReadonlySet<string> = new Set([
  'equals',
  'not_equals',
  'contains',
  'checked',
  'not_checked',
]);
const VALUE_REQUIRED_CONDITION_OPERATORS: ReadonlySet<string> = new Set([
  'equals',
  'not_equals',
  'contains',
]);
const VALUE_FORBIDDEN_CONDITION_OPERATORS: ReadonlySet<string> = new Set([
  'checked',
  'not_checked',
]);

const WITHIN_NEXT_MAXIMUM_DAYS = 365;
const MAXIMUM_FILTERS = 8;

function findByKey(
  effective: readonly StructureProperty[],
  key: string | null,
): StructureProperty | undefined {
  if (key === null) {
    return undefined;
  }
  return effective.find((property) => property.key === key);
}

/**
 * A board or chart needs a single-select property to group by, and a calendar or timeline needs a
 * date-shaped one to place items by - the same requirement `ViewKinds.All`
 * (`backend/src/Nix.Api/Domain/Views/ViewDefinition.cs:182-252`) declares per kind. Stricter than
 * `ViewDefinitionRules.Refuse` actually enforces on write, though: that check only asks whether
 * the field is present (`ViewDefinitionRules.cs:43-47`), because `SetContainerViewsHandler.Validate`
 * is given no schema to check a key's type against. The type check exists only on the read path,
 * in `ViewDefinition.CanRender`. This function applies `CanRender`'s stricter rule at write time,
 * on purpose, so a pet is told before a view renders empty rather than after - the fixture cases
 * this reaches beyond Core's own `Refuse` are marked `"viewsScope": "client-only"` in
 * `fixtures/rule-parity.json` for exactly this reason.
 */
function refuseKindRequirement(
  view: StructureView,
  effective: readonly StructureProperty[],
): string | null {
  if (view.kind === 'board' || view.kind === 'chart') {
    const property = findByKey(effective, view.groupBy);
    if (property?.type !== 'select') {
      return `'${view.name}': a ${view.kind} needs a property to group by.`;
    }
  }

  if (view.kind === 'calendar') {
    const property = findByKey(effective, view.dateProperty);
    if (property === undefined || !isDateShaped(property.type)) {
      return `'${view.name}': a calendar needs a date property.`;
    }
  }

  if (view.kind === 'timeline') {
    const property = findByKey(effective, view.dateProperty);
    if (property === undefined || !isDateShaped(property.type)) {
      return `'${view.name}': a timeline needs a date to start from.`;
    }
  }

  return null;
}

/**
 * The measure-validity check is real Core parity (`ViewDefinitionRules.cs:49-53` checks
 * `Measure` on every kind, and the "needs a property to total" check is chart-specific there too,
 * `:55-61`). The other two checks here are architecture 4 item 5's client-only additions: a
 * gallery cover must resolve to a picture property, and a chart's measure property must resolve
 * to a number. Core does not check either at the type level (a gallery with no cover, or one
 * pointed at the wrong type, still stores) - these exist so a pet is told before the card or the
 * bar draws nothing useful, not because Core will refuse them.
 */
function refuseMeasureAndCover(
  view: StructureView,
  effective: readonly StructureProperty[],
): string | null {
  if (view.kind === 'gallery' && view.coverProperty !== null) {
    const property = findByKey(effective, view.coverProperty);
    if (property?.type !== 'image') {
      return `'${view.name}': a gallery cover must be a picture property.`;
    }
  }

  // Core checks a view's `Measure` for every kind, not only `chart` (`ViewDefinitionRules.cs:49-53`)
  // - a stray `measure` on an unrelated view kind is still refused if it names something that
  // isn't `count` or `sum`.
  const measure = view.measure ?? null;
  if (measure !== null && measure !== 'count' && measure !== 'sum') {
    return `'${view.name}': '${measure}' is not a measure a chart can draw; use 'count' or 'sum'.`;
  }

  if (view.kind === 'chart' && view.measure === 'sum') {
    if (view.measureProperty === null || view.measureProperty === undefined) {
      return `'${view.name}' totals a property, so it needs one to total.`;
    }
    const property = findByKey(effective, view.measureProperty);
    if (property === undefined || valueShapeOf(property.type) !== 'number') {
      return `'${view.name}': a chart that totals needs a number property.`;
    }
  }

  return null;
}

/**
 * Ports `QueryOperators.Refuse` (`backend/src/Nix.Api/Domain/Views/FilterRule.cs:40-170`): grammar
 * only. Whether `filter.property` names a real property is deliberately not asked here, for the
 * same reason Core does not ask it - a query view spans containers and a rule naming a property
 * nothing declares simply matches nothing.
 */
function refuseFilter(filter: StructureFilter): string | null {
  if (filter.property.length === 0) {
    return 'a filter needs a property to test';
  }
  if (filter.property.length > 128) {
    return "a filter's property key may be at most 128 characters";
  }
  if (!KNOWN_FILTER_OPERATORS.has(filter.operator)) {
    return `'${filter.operator}' is not a filter operator`;
  }
  if (filter.value.length === 0) {
    return 'a filter needs a value to compare against';
  }
  if (filter.value.length > 512) {
    return "a filter's value may be at most 512 characters";
  }
  if (
    DAY_FILTER_OPERATORS.has(filter.operator) &&
    filter.value !== 'today' &&
    !isRealCalendarDay(filter.value)
  ) {
    return `'${filter.operator}' reads a day: 'today' or a date written yyyy-MM-dd`;
  }
  if (filter.operator === 'within-next') {
    const days = Number(filter.value);
    if (!/^\d+$/.test(filter.value) || days < 1 || days > WITHIN_NEXT_MAXIMUM_DAYS) {
      return `'within-next' reads a number of days from 1 to ${String(WITHIN_NEXT_MAXIMUM_DAYS)}`;
    }
  }
  return null;
}

/**
 * A form condition's operator and value must pair the way `condSchema` cannot enforce on its own
 * (per this task's card, "form condition op/value pairing"): the equality and `contains`
 * operators need a value to compare against, and the two checkbox operators - `checked`,
 * `not_checked` - ask a yes-or-no question that a value would only contradict.
 */
function refuseConditionValue(condition: StructureFormCondition): string | null {
  const hasValue = condition.value !== null && condition.value.length > 0;
  if (VALUE_REQUIRED_CONDITION_OPERATORS.has(condition.operator) && !hasValue) {
    return `has an '${condition.operator}' condition with no value to compare against`;
  }
  if (VALUE_FORBIDDEN_CONDITION_OPERATORS.has(condition.operator) && hasValue) {
    return `has a '${condition.operator}' condition that carries a value it does not use`;
  }
  return null;
}

function refuseCondition(
  conditions: readonly StructureFormCondition[],
  earlierFields: ReadonlySet<string>,
): string | null {
  for (const condition of conditions) {
    if (!earlierFields.has(condition.fieldBlockId)) {
      return 'has a condition that does not reference an earlier field';
    }
    if (!KNOWN_CONDITION_OPERATORS.has(condition.operator)) {
      return `uses unknown condition operator '${condition.operator}'`;
    }
    const valueProblem = refuseConditionValue(condition);
    if (valueProblem !== null) {
      return valueProblem;
    }
  }
  return null;
}

/**
 * Ports the form half of `ViewDefinitionRules.Refuse`
 * (`backend/src/Nix.Api/Domain/Views/ViewDefinitionRules.cs:152-260`), plus one addition the
 * server does not need: a field block may not name a computed property, because nothing a
 * respondent fills in can be written back to a formula or a rollup.
 */
function refuseForm(
  form: StructureForm | null | undefined,
  effective: readonly StructureProperty[],
): string | null {
  if (form === null || form === undefined || form.pages.length === 0) {
    return 'an interactive form needs at least one page';
  }
  if (form.titleMode !== 'generated' && form.titleMode !== 'field') {
    return 'the response title must be generated or taken from a field';
  }

  const byKey = new Map(effective.map((property) => [property.key, property]));
  const blockIds = new Set<string>();
  const fieldIds = new Set<string>();
  const earlierFields = new Set<string>();
  const pageIds = new Set<string>();
  const identityRoles = new Set<string>();

  for (const page of form.pages) {
    if (page.id.length === 0 || pageIds.has(page.id) || page.blocks.length === 0) {
      return 'every page needs a unique identifier and at least one block';
    }
    pageIds.add(page.id);

    const pageCondition = refuseCondition(page.visibleWhen, earlierFields);
    if (pageCondition !== null) {
      return `page '${page.id}' ${pageCondition}`;
    }

    for (const block of page.blocks) {
      if (block.id.length === 0 || blockIds.has(block.id)) {
        return 'every form block needs a unique identifier';
      }
      blockIds.add(block.id);

      if (
        block.kind === 'field' &&
        (block.propertyKey === null || block.propertyKey.trim().length === 0)
      ) {
        return `field '${block.id}' needs a property`;
      }

      if (block.kind !== 'field' && block.kind !== 'heading' && block.kind !== 'paragraph') {
        return `'${block.kind}' is not a form block kind`;
      }

      const blockCondition = refuseCondition(block.visibleWhen, earlierFields);
      if (blockCondition !== null) {
        return `block '${block.id}' ${blockCondition}`;
      }

      if (block.identityRole !== null) {
        if (
          block.kind !== 'field' ||
          (block.identityRole !== 'name' && block.identityRole !== 'email')
        ) {
          return `block '${block.id}' has an invalid respondent identity role`;
        }
        if (identityRoles.has(block.identityRole)) {
          return `respondent ${block.identityRole} may be assigned to only one field`;
        }
        identityRoles.add(block.identityRole);
      }

      if (block.kind === 'field') {
        const property = block.propertyKey !== null ? byKey.get(block.propertyKey) : undefined;
        if (property !== undefined && isComputedType(property.type)) {
          return `field '${block.id}' cannot use '${property.label}', which is computed`;
        }
        fieldIds.add(block.id);
        earlierFields.add(block.id);
      }
    }
  }

  if (
    form.titleMode === 'field' &&
    (form.titleFieldBlockId === null || !fieldIds.has(form.titleFieldBlockId))
  ) {
    return 'the response-title field must name a field block';
  }

  return null;
}

/**
 * Ports `ViewDefinitionRules.Refuse`'s habit-chart shape check
 * (`backend/src/Nix.Api/Domain/Views/ViewDefinitionRules.cs:75-91`): unique, bounded identifiers, a
 * supported chart kind, a habit, and an ordered range of at most 366 days. Dates are compared as
 * whole days, matching `DayNumber` subtraction there.
 */
function refuseHabitWidgets(view: StructureView): string | null {
  const widgets = view.habitWidgets ?? [];
  if (widgets.length === 0) {
    return null;
  }
  if (widgets.length > MAXIMUM_HABIT_WIDGETS) {
    return `A view may contain at most ${String(MAXIMUM_HABIT_WIDGETS)} habit charts.`;
  }

  const widgetIds = new Set<string>();
  for (const widget of widgets) {
    if (isWellFormedHabitWidget(widget, widgetIds)) {
      widgetIds.add(widget.id);
      continue;
    }
    return 'Habit charts need unique identifiers, a supported chart type, a habit, and an ordered range of at most 366 days.';
  }
  return null;
}

function isWellFormedHabitWidget(
  widget: StructureHabitWidget,
  seenIds: ReadonlySet<string>,
): boolean {
  if (
    widget.id.length === 0 ||
    widget.id.length > 128 ||
    seenIds.has(widget.id) ||
    !HABIT_WIDGET_KINDS.has(widget.kind) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(widget.habitId) ||
    !isCalendarDay(widget.from) ||
    !isCalendarDay(widget.to)
  ) {
    return false;
  }
  const rangeDays = daysBetween(widget.from, widget.to);
  return rangeDays >= 0 && rangeDays < MAXIMUM_HABIT_RANGE_DAYS;
}

function isCalendarDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && isRealCalendarDay(value);
}

function daysBetween(from: string, to: string): number {
  const fromDate = new Date(`${from}T00:00:00Z`).getTime();
  const toDate = new Date(`${to}T00:00:00Z`).getTime();
  return Math.round((toDate - fromDate) / MILLISECONDS_PER_DAY);
}

/**
 * Ports `ViewDefinitionRules.Refuse`'s companion-view checks
 * (`backend/src/Nix.Api/Domain/Views/ViewDefinitionRules.cs:110-133`): a companion must name
 * another view in the same set, must say where it sits, and a companion cannot itself carry a
 * companion (no nesting).
 */
function refuseCompanion(
  view: StructureView,
  views: readonly StructureView[],
  ids: ReadonlySet<string>,
): string | null {
  const companion = view.companionViewId ?? null;
  if (companion === null) {
    return view.companionPlacement != null
      ? `'${view.name}': companion placement needs a companion view.`
      : null;
  }

  if (!ids.has(companion) || companion === view.id) {
    return `'${view.name}': its companion must name another view in this item.`;
  }
  if (view.companionPlacement !== 'below' && view.companionPlacement !== 'beside') {
    return `'${view.name}': a companion must be placed 'below' or 'beside'.`;
  }
  const target = views.find((candidate) => candidate.id === companion);
  if (target?.companionViewId != null) {
    return `'${view.name}': companion views cannot contain another companion.`;
  }
  return null;
}

/**
 * Ports the view-writing rules a pet's compiled views must satisfy: the whole-set rules of
 * `ViewDefinitionRules.Refuse` (view count, identifiers, `cardSize`/`layout` vocabulary, habit
 * chart shape, companion placement, default-view membership - all "now reachable with real ids"
 * once the compiler, not a synthetic per-view id, produces every `StructureView.id`), the kind
 * requirements of `ViewKinds.All`, the filter grammar of `QueryOperators.Refuse`, and the form
 * rules of `ViewDefinitionRules.RefuseForm` - plus the two client-only additions architecture 4
 * item 5 calls for (gallery cover, chart measure) and the computed-field-in-a-form rule item 7
 * adds. Returns the first reason any view cannot be stored, or `null`, exactly as Core's own
 * `Refuse` does for one call over the whole set.
 */
export function refuseViews(
  views: readonly StructureView[],
  effective: readonly StructureProperty[],
  defaultId: string | null,
): string | null {
  if (views.length > MAXIMUM_VIEWS) {
    return `A container may offer at most ${String(MAXIMUM_VIEWS)} views.`;
  }

  const ids = new Set<string>();

  for (const view of views) {
    if (view.id.length === 0) {
      return 'Every view needs an identifier.';
    }
    if (ids.has(view.id)) {
      return `'${view.id}' is used by more than one view; a shared link names one view.`;
    }
    ids.add(view.id);

    if (view.name.length === 0) {
      return 'Every view needs a name.';
    }

    if (view.id === RESERVED_VIEW_ID) {
      return `'${RESERVED_VIEW_ID}' is reserved for the item's own body; give this view another name.`;
    }

    const kindProblem = refuseKindRequirement(view, effective);
    if (kindProblem !== null) {
      return kindProblem;
    }

    const measureProblem = refuseMeasureAndCover(view, effective);
    if (measureProblem !== null) {
      return measureProblem;
    }

    if (view.cardSize !== null && !CARD_SIZES.has(view.cardSize)) {
      return `'${view.name}': '${view.cardSize}' is not a card size; use 'small', 'medium' or 'large'.`;
    }
    if (view.layout !== null && !LAYOUTS.has(view.layout)) {
      return `'${view.name}': '${view.layout}' is not a layout; use 'list' or 'grid'.`;
    }

    const habitProblem = refuseHabitWidgets(view);
    if (habitProblem !== null) {
      return habitProblem;
    }

    if (view.filters.length > 0) {
      if (view.filters.length > MAXIMUM_FILTERS) {
        return `'${view.name}': a view may carry at most ${String(MAXIMUM_FILTERS)} filters.`;
      }
      for (const filter of view.filters) {
        const reason = refuseFilter(filter);
        if (reason !== null) {
          return `'${view.name}': ${reason}.`;
        }
      }
    }

    if (view.kind === 'interactive_form') {
      const reason = refuseForm(view.interactiveForm, effective);
      if (reason !== null) {
        return `'${view.name}': ${reason}.`;
      }
    }
  }

  for (const view of views) {
    const companionProblem = refuseCompanion(view, views, ids);
    if (companionProblem !== null) {
      return companionProblem;
    }
  }

  if (
    defaultId !== null &&
    defaultId.length > 0 &&
    defaultId !== RESERVED_VIEW_ID &&
    !ids.has(defaultId)
  ) {
    return `'${defaultId}' is not one of these views, so it cannot be the one that opens.`;
  }

  return null;
}
