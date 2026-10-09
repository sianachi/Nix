export type {
  StructureFilter,
  StructureFilterEntry,
  StructureFilterGroup,
  StructureForm,
  StructureFormBlock,
  StructureFormCondition,
  StructureFormPage,
  StructureHabitWidget,
  StructureProperty,
  StructureSchema,
  StructureView,
} from './types.js';

export {
  canChartBy,
  canGroupBy,
  canSectionBy,
  foldNeedsProperty,
  isComputedType,
  isDateShaped,
  PROPERTY_TYPES,
  propertyTypeLabel,
  propertyTypeWord,
  ROLLUP_AGGREGATES,
  rollupAggregateLabel,
  TYPE_GROUP_KEY,
  valueShapeOf,
} from './vocabulary/property-types.js';
export type { PropertyValueShape } from './vocabulary/property-types.js';

export {
  defaultInteractiveForm,
  findStructuredRecipe,
  keyForProperty,
  SMART_LIST_STARTERS,
  STRUCTURED_RECIPES,
  viewForRecipe,
} from './vocabulary/recipes.js';
export type { StructuredRecipe, StructuredRecipeId } from './vocabulary/recipes.js';

export { findSmartList, SMART_LISTS, smartListView } from './vocabulary/smart-lists.js';
export type { SmartListPreset } from './vocabulary/smart-lists.js';

export { mergeProperties } from './vocabulary/merge-properties.js';

export * from './spec/index.js';

export {
  buildCatalog,
  buildPetTools,
  CONSULT_ONLY_OPERATION_NAMES,
  FORM_RULES,
  HABIT,
  INIT_RULE_KINDS,
  LIMITS,
  NEVER_OPERATIONS,
  NEVER_PET_PROPERTY_TYPE,
  NEVER_PET_RECIPES,
  normalizeForCodex,
  QUERY_OPERATORS,
  READ_ONLY_OPERATION_NAMES,
  RECURRENCE,
  renderChat,
  renderConsult,
  TEMPLATE_INPUT_TYPES,
  VIEW_KIND_RULES,
  WORKSPACE_OPERATIONS,
} from './catalog/index.js';
export type {
  Catalog,
  CatalogLimits,
  CatalogPropertyType,
  CatalogRecipe,
  CatalogRollupAggregate,
  CatalogSmartList,
  CatalogViewKind,
  FlatWorkspaceToolArgs,
  FormRules,
  HabitRules,
  PetToolDefinition,
  QueryOperatorRule,
  RecurrenceRules,
  ViewKindOptionalField,
  ViewKindRequirement,
  ViewKindRule,
  WorkspaceOperation,
} from './catalog/index.js';
export * from './compile/index.js';
export * from './describe/index.js';
export type { Problem, ValidationContext, ValidationReport } from './validate/report.js';
export { refuseSchema } from './validate/schema-rules.js';
export { refuseViews } from './validate/view-rules.js';
export { validateValue } from './validate/values.js';
export { type SpecOperation, validateSpec } from './validate/spec.js';

export * from './blueprint/index.js';

export { consultScenarioSchema, evalExpectationsSchema } from './evals/schema.js';
export type { ConsultScenario, EvalExpectations, Predicate } from './evals/schema.js';
export { scoreBlueprint } from './evals/score.js';
export { chatCaseSchema, chatSuiteSchema, chatAssertionSchema } from './evals/chat-schema.js';
export type { ChatAssertion, ChatCase } from './evals/chat-schema.js';
export type { EvalCriterion, EvalScore } from './evals/score.js';
