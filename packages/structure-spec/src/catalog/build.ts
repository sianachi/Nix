import { FORMULA_FUNCTION_NAMES, PROPERTY_FORMULA_HELP, type SheetErrorCode } from '@nix/sheet';

import { PROPERTY_TYPES, ROLLUP_AGGREGATES, valueShapeOf } from '../vocabulary/property-types.js';
import { STRUCTURED_RECIPES } from '../vocabulary/recipes.js';
import { SMART_LISTS } from '../vocabulary/smart-lists.js';
import {
  FORM_RULES,
  HABIT,
  INIT_RULE_KINDS,
  LIMITS,
  NEVER_OPERATIONS,
  NEVER_PET_PROPERTY_TYPE,
  NEVER_PET_RECIPES,
  QUERY_OPERATORS,
  RECURRENCE,
  STRUCTURE_OPERATIONS,
  TEMPLATE_INPUT_TYPES,
  VIEW_KIND_RULES,
  type CatalogLimits,
  type FormRules,
  type HabitRules,
  type QueryOperatorRule,
  type RecurrenceRules,
  type StructureOperationsByMode,
  type ViewKindRule,
} from './tables.js';

/**
 * Builds the capability catalog: what the pet may design with, drawn from the tables in
 * `tables.ts` and the vocabulary the web wizards already share, rather than restated by hand.
 * This module has no side effect of its own; `scripts/build-catalog.ts` calls it and writes the
 * generated files.
 */

export interface CatalogPropertyType {
  readonly type: string;
  readonly label: string;
  readonly shape: string;
}

export interface CatalogRecipe {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly viewKind: string;
}

export interface CatalogSmartList {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
}

export interface CatalogRollupAggregate {
  readonly value: string;
  readonly label: string;
}

export interface Catalog {
  readonly propertyTypes: readonly CatalogPropertyType[];
  readonly rollupAggregates: readonly CatalogRollupAggregate[];
  readonly recipes: readonly CatalogRecipe[];
  readonly smartLists: readonly CatalogSmartList[];
  readonly viewKinds: readonly ViewKindRule[];
  readonly queryOperators: readonly QueryOperatorRule[];
  readonly formRules: FormRules;
  readonly structureOperations: StructureOperationsByMode;
  readonly limits: CatalogLimits;
  readonly templateInputTypes: readonly string[];
  readonly initRuleKinds: readonly string[];
  readonly recurrence: RecurrenceRules;
  readonly habit: HabitRules;
  readonly neverOperations: readonly string[];
  readonly formulaFunctions: readonly string[];
  readonly formulaHelp: Readonly<Record<SheetErrorCode, string>>;
}

export function buildCatalog(): Catalog {
  const propertyTypes: CatalogPropertyType[] = PROPERTY_TYPES.filter(
    (entry) => entry.value !== NEVER_PET_PROPERTY_TYPE,
  ).map((entry) => ({
    type: entry.value,
    label: entry.label,
    shape: valueShapeOf(entry.value),
  }));

  const recipes: CatalogRecipe[] = STRUCTURED_RECIPES.filter(
    (recipe) => !NEVER_PET_RECIPES.has(recipe.id),
  ).map((recipe) => ({
    id: recipe.id,
    label: recipe.label,
    detail: recipe.detail,
    viewKind: recipe.viewKind,
  }));

  const smartLists: CatalogSmartList[] = SMART_LISTS.map((preset) => ({
    id: preset.id,
    label: preset.label,
    detail: preset.detail,
  }));

  const rollupAggregates: CatalogRollupAggregate[] = ROLLUP_AGGREGATES.map((entry) => ({
    value: entry.value,
    label: entry.label,
  }));

  return {
    propertyTypes,
    rollupAggregates,
    recipes,
    smartLists,
    viewKinds: VIEW_KIND_RULES,
    queryOperators: QUERY_OPERATORS,
    formRules: FORM_RULES,
    structureOperations: STRUCTURE_OPERATIONS,
    limits: LIMITS,
    templateInputTypes: TEMPLATE_INPUT_TYPES,
    initRuleKinds: INIT_RULE_KINDS,
    recurrence: RECURRENCE,
    habit: HABIT,
    neverOperations: NEVER_OPERATIONS,
    formulaFunctions: FORMULA_FUNCTION_NAMES,
    formulaHelp: PROPERTY_FORMULA_HELP,
  };
}

function viewKindLine(kind: ViewKindRule): string {
  const requirement =
    kind.requires === null ? 'no required field' : `needs a ${kind.requires.shape} property`;
  const optional = kind.optional.length
    ? '; optional: ' + kind.optional.map((field) => `${field.field} (${field.shape})`).join(', ')
    : '';
  return `- ${kind.label} (${kind.kind}): ${requirement}${optional}. ${kind.description}`;
}

/**
 * The chat-mode catalog text: field types, view kinds and their requirements, recipes and the
 * never-ops, at most 3000 characters. Chat pets do additive edits to existing structure and never
 * design a system from scratch, so they need the vocabulary but not formulas, forms, recurrence,
 * habits or the blueprint schema.
 */
export function renderChat(catalog: Catalog): string {
  const lines: string[] = [];
  lines.push('Section: Structure operations');
  lines.push(catalog.structureOperations.chat.join(', '));
  lines.push('');
  lines.push('Section: Property types');
  lines.push(catalog.propertyTypes.map((type) => `${type.type} (${type.label})`).join(', '));
  lines.push('');
  lines.push('Section: View kinds');
  for (const kind of catalog.viewKinds) {
    lines.push(viewKindLine(kind));
  }
  lines.push('');
  lines.push('Section: Recipes');
  lines.push(
    catalog.recipes.map((recipe) => `${recipe.id}: ${recipe.label} - ${recipe.detail}`).join('\n'),
  );
  lines.push('');
  lines.push('Section: Never');
  for (const rule of catalog.neverOperations) {
    lines.push(`- ${rule}`);
  }
  return lines.join('\n');
}

/**
 * The consult-mode catalog text: everything the chat text carries plus formulas, rollups, form
 * rules, smart lists, recurrence, habits, the template vocabulary, the blueprint schema summary
 * and the efficiency patterns, at most 12000 characters.
 */
export function renderConsult(catalog: Catalog, patterns: string): string {
  const lines: string[] = [renderChat(catalog), ''];

  lines.push('Section: Query operators');
  for (const operator of catalog.queryOperators) {
    lines.push(`- ${operator.op}: ${operator.grammar}`);
  }
  lines.push('');

  lines.push('Section: Smart lists');
  lines.push(
    catalog.smartLists
      .map((preset) => `${preset.id}: ${preset.label} - ${preset.detail}`)
      .join('\n'),
  );
  lines.push('');

  lines.push('Section: Rollup aggregates');
  lines.push(
    catalog.rollupAggregates
      .map((aggregate) => `${aggregate.value} (${aggregate.label})`)
      .join(', '),
  );
  lines.push('');

  lines.push('Section: Formulas');
  lines.push('Functions: ' + catalog.formulaFunctions.join(', '));
  lines.push('A formula reads other properties by name in square brackets, as [estimate].');
  for (const code of Object.keys(catalog.formulaHelp) as SheetErrorCode[]) {
    lines.push(`- ${code}: ${catalog.formulaHelp[code]}`);
  }
  lines.push('');

  lines.push('Section: Forms');
  lines.push(`Block kinds: ${catalog.formRules.blockKinds.join(', ')}`);
  lines.push(`Condition operators: ${catalog.formRules.conditionOperators.join(', ')}`);
  lines.push(`Identity roles: ${catalog.formRules.identityRoles.join(', ')}`);
  lines.push(`Title modes: ${catalog.formRules.titleModes.join(', ')}`);
  lines.push('');

  lines.push('Section: Recurrence');
  lines.push(
    `Frequencies: ${catalog.recurrence.frequencies.join(', ')}; interval ${String(catalog.recurrence.intervalMin)}-${String(catalog.recurrence.intervalMax)}. Needs a due_date value on the same node.`,
  );
  lines.push('');

  lines.push('Section: Habits');
  lines.push(
    `Frequencies: ${catalog.habit.frequencies.join(', ')}. A habit node must be a child of a node with a habit_tracker view.`,
  );
  lines.push('');

  lines.push('Section: Templates');
  lines.push(`Input types: ${catalog.templateInputTypes.join(', ')}`);
  lines.push(`Init rule kinds: ${catalog.initRuleKinds.join(', ')}`);
  lines.push('');

  lines.push('Section: Blueprint schema');
  lines.push(
    `A blueprint is version 1, a title, a one-paragraph summary, a root node, up to ${String(catalog.limits.inputsPerBlueprint)} inputs ` +
      `and up to ${String(catalog.limits.initRulesPerBlueprint)} init rules. A node has an id, a title, up to ${String(catalog.limits.fieldsPerNode)} fields, ` +
      `up to ${String(catalog.limits.viewsPerNode)} views (a node with views is a container), markdown, recurrence, habit ` +
      `settings, values and children. Limits: ${String(catalog.limits.blueprintNodes)} nodes total, ` +
      `${String(catalog.limits.blueprintNonSampleNodes)} non-sample, depth ${String(catalog.limits.blueprintDepth)}, ` +
      `${String(catalog.limits.fieldsPerBlueprint)} fields, ${String(catalog.limits.viewsPerBlueprint)} views, ` +
      `${String(catalog.limits.sampleEntries)} sample entries, ${String(catalog.limits.plannedWritesPerBuild)} planned writes.`,
  );
  lines.push('');

  lines.push('Section: Patterns');
  lines.push(patterns.trim());

  return lines.join('\n');
}
