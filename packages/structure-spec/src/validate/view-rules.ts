import type {
  StructureFilter,
  StructureForm,
  StructureFormCondition,
  StructureProperty,
  StructureView,
} from '../types.js';
import { isComputedType, isDateShaped, valueShapeOf } from '../vocabulary/property-types.js';
import { isRealCalendarDay } from './values.js';

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
 * Ports the view-writing rules a pet's compiled views must satisfy: the kind requirements of
 * `ViewKinds.All`, the filter grammar of `QueryOperators.Refuse`, and the form rules of
 * `ViewDefinitionRules.RefuseForm` - plus the two client-only additions architecture 4 item 5
 * calls for (gallery cover, chart measure) and the computed-field-in-a-form rule item 7 adds.
 * Returns the first reason any view cannot be stored, or `null`.
 *
 * `defaultId` is accepted for the same shape `refuseSchema` and Core's own `Refuse` take, but this
 * task's operations never propose one that is not among `views` - the compiler assigns
 * `makeDefault` from a spec's own `default: true` view - so no rule here reads it yet.
 */
export function refuseViews(
  views: readonly StructureView[],
  effective: readonly StructureProperty[],
  defaultId: string | null,
): string | null {
  void defaultId;

  for (const view of views) {
    const kindProblem = refuseKindRequirement(view, effective);
    if (kindProblem !== null) {
      return kindProblem;
    }

    const measureProblem = refuseMeasureAndCover(view, effective);
    if (measureProblem !== null) {
      return measureProblem;
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

  return null;
}
