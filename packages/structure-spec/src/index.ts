export type {
  StructureFilter,
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
  foldNeedsProperty,
  isComputedType,
  isDateShaped,
  PROPERTY_TYPES,
  propertyTypeLabel,
  propertyTypeWord,
  ROLLUP_AGGREGATES,
  rollupAggregateLabel,
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
  FORM_RULES,
  HABIT,
  INIT_RULE_KINDS,
  LIMITS,
  NEVER_OPERATIONS,
  NEVER_PET_PROPERTY_TYPE,
  NEVER_PET_RECIPES,
  QUERY_OPERATORS,
  RECURRENCE,
  renderChat,
  renderConsult,
  TEMPLATE_INPUT_TYPES,
  VIEW_KIND_RULES,
} from './catalog/index.js';
export type {
  Catalog,
  CatalogLimits,
  CatalogPropertyType,
  CatalogRecipe,
  CatalogRollupAggregate,
  CatalogSmartList,
  FormRules,
  HabitRules,
  QueryOperatorRule,
  RecurrenceRules,
  ViewKindOptionalField,
  ViewKindRequirement,
  ViewKindRule,
} from './catalog/index.js';
export * from './compile/index.js';
export * from './describe/index.js';
export type { Problem, ValidationContext, ValidationReport } from './validate/report.js';
export { refuseSchema } from './validate/schema-rules.js';
export { refuseViews } from './validate/view-rules.js';
export { validateValue } from './validate/values.js';
export { type SpecOperation, validateSpec } from './validate/spec.js';
