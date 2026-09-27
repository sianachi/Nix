export {
  type Catalog,
  type CatalogPropertyType,
  type CatalogRecipe,
  type CatalogRollupAggregate,
  type CatalogSmartList,
  buildCatalog,
  renderChat,
  renderConsult,
} from './build.js';
export {
  CONSULT_ONLY_OPERATION_NAMES,
  FORM_RULES,
  HABIT,
  INIT_RULE_KINDS,
  LIMITS,
  NEVER_OPERATIONS,
  NEVER_PET_PROPERTY_TYPE,
  NEVER_PET_RECIPES,
  QUERY_OPERATORS,
  READ_ONLY_OPERATION_NAMES,
  RECURRENCE,
  TEMPLATE_INPUT_TYPES,
  VIEW_KIND_RULES,
  WORKSPACE_OPERATIONS,
  type CatalogLimits,
  type FormRules,
  type HabitRules,
  type QueryOperatorRule,
  type RecurrenceRules,
  type ViewKindOptionalField,
  type ViewKindRequirement,
  type ViewKindRule,
  type WorkspaceOperation,
} from './tables.js';
// buildPetTools/normalizeForCodex (tools.ts) are exported directly from the package's top-level
// `index.ts`, not re-exported here: tools.ts imports the spec schemas (which import
// blueprint/schema.ts, which imports this module for HABIT/INIT_RULE_KINDS/RECURRENCE/
// TEMPLATE_INPUT_TYPES) - re-exporting tools.ts from here would close that into an import cycle
// (this module -> tools.ts -> spec/index.ts -> blueprint/schema.ts -> this module) that leaves
// `initRuleSpecSchema` undefined when `spec/save.ts` first runs.
export {
  EXAMPLE_ITEM_ID,
  flattenToolExample,
  TOOL_EXAMPLES,
  type FlatWorkspaceToolArgs,
} from './tool-examples.js';
