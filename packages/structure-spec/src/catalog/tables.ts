/**
 * The pure data tables behind the pet's capability catalog: everything a model needs to know
 * about what it may build, in one place, so the catalog text (`build.ts`), the Zod limits a
 * later task adds under `spec/*`, and the parity tests a later task adds for Go, C# and web all
 * read from the same source instead of restating it three times.
 *
 * These are facts about what Core and the compiler accept, not facts about the vocabulary
 * already carried by `property-types.ts`, `recipes.ts` or `smart-lists.ts` - `build.ts` composes
 * both kinds into one catalog.
 */

/** How a view kind's one required field, if it has one, must be satisfied. */
export type ViewKindRequirement =
  | { readonly field: 'groupBy'; readonly shape: 'select' }
  | { readonly field: 'date'; readonly shape: 'date-shaped' }
  | null;

/** One optional field a view kind accepts beyond its requirement, and what it needs to be. */
export interface ViewKindOptionalField {
  readonly field: string;
  readonly shape: string;
}

export interface ViewKindRule {
  readonly kind: string;
  readonly label: string;
  readonly requires: ViewKindRequirement;
  readonly optional: readonly ViewKindOptionalField[];
  readonly description: string;
}

/**
 * Every view kind a spec or a blueprint may declare, and what it needs from the schema.
 *
 * `drive` and `finance` are Core view kinds (`ViewKinds.All` in `ViewDefinition.cs`) the pet may
 * never offer - a public file drive and personal finances are not something a model should be
 * designing on somebody's behalf - so they have no row here. A future parity test comparing this
 * table against `ViewKinds.All` needs to add both back in before comparing.
 */
export const VIEW_KIND_RULES = [
  {
    kind: 'list',
    label: 'List',
    requires: null,
    optional: [],
    description: 'Rows and columns, one row per child.',
  },
  {
    kind: 'board',
    label: 'Board',
    requires: { field: 'groupBy', shape: 'select' },
    optional: [],
    description: 'Cards grouped into columns by a single select property.',
  },
  {
    kind: 'calendar',
    label: 'Calendar',
    requires: { field: 'date', shape: 'date-shaped' },
    optional: [],
    description: 'Items placed on a day, week or month by a date property.',
  },
  {
    kind: 'timeline',
    label: 'Timeline',
    requires: { field: 'date', shape: 'date-shaped' },
    optional: [{ field: 'endDate', shape: 'date-shaped' }],
    description: 'Bars across a time axis; without an end date an item is a milestone.',
  },
  {
    kind: 'gallery',
    label: 'Gallery',
    requires: null,
    optional: [{ field: 'cover', shape: 'image' }],
    description: 'Children as cards, each optionally showing a picture property.',
  },
  {
    kind: 'sheet',
    label: 'Spreadsheet',
    requires: null,
    optional: [],
    description: 'Children as an editable grid, one row per child and one column per property.',
  },
  {
    kind: 'form',
    label: 'Form',
    requires: null,
    optional: [],
    description: 'A single-page fillable form over the schema; each submission is a new child.',
  },
  {
    kind: 'interactive_form',
    label: 'Interactive form',
    requires: null,
    optional: [],
    description: 'A multi-page, conditional form whose answers create a child item.',
  },
  {
    kind: 'query',
    label: 'Smart list',
    requires: null,
    optional: [],
    description: 'A saved cross-container query, run server-side from stored filters.',
  },
  {
    kind: 'chart',
    label: 'Chart',
    requires: { field: 'groupBy', shape: 'select' },
    optional: [{ field: 'measureField', shape: 'number' }],
    description: 'Children summarised into bars, counted or totalled by a number property.',
  },
  {
    kind: 'habit_tracker',
    label: 'Habit tracker',
    requires: null,
    optional: [],
    description: 'Habit children arranged by local date with recorded progress.',
  },
] as const satisfies readonly ViewKindRule[];

/** The recipe ids the pet may never use: a file drive and personal finances are studio-only. */
export const NEVER_PET_RECIPES: ReadonlySet<string> = new Set(['drive', 'finances']);

/** The one property type the pet may never declare: values are member UUIDs it cannot verify. */
export const NEVER_PET_PROPERTY_TYPE = 'assignee';

export interface QueryOperatorRule {
  readonly op: string;
  readonly grammar: string;
}

/** The six operators a query view's filters may use, and the value each one reads. */
export const QUERY_OPERATORS = [
  { op: 'equals', grammar: 'a literal value, or "me" for the calling principal' },
  { op: 'not-equals', grammar: 'a literal value, or "me" for the calling principal' },
  { op: 'on', grammar: '"today" or a yyyy-MM-dd date' },
  { op: 'before', grammar: '"today" or a yyyy-MM-dd date' },
  { op: 'on-or-after', grammar: '"today" or a yyyy-MM-dd date' },
  { op: 'within-next', grammar: 'a whole number of days' },
] as const satisfies readonly QueryOperatorRule[];

export interface FormRules {
  readonly blockKinds: readonly string[];
  readonly conditionOperators: readonly string[];
  readonly identityRoles: readonly string[];
  readonly titleModes: readonly string[];
}

/** What an interactive form's pages, blocks and conditions may be built from. */
export const FORM_RULES = {
  blockKinds: ['field', 'heading', 'paragraph'],
  conditionOperators: ['equals', 'not_equals', 'contains', 'checked', 'not_checked'],
  identityRoles: ['name', 'email'],
  titleModes: ['generated', 'field'],
} as const satisfies FormRules;

export interface CatalogLimits {
  readonly rawToolCallBytes: number;
  readonly specJsonChars: number;
  readonly specJsonDepth: number;
  readonly blueprintNodes: number;
  readonly blueprintNonSampleNodes: number;
  readonly blueprintDepth: number;
  readonly fieldsPerNode: number;
  readonly fieldsPerBlueprint: number;
  readonly viewsPerNode: number;
  readonly viewsPerBlueprint: number;
  readonly sampleEntries: number;
  readonly plannedWritesPerBuild: number;
  readonly entriesPerCreateEntries: number;
  readonly inputsPerBlueprint: number;
  readonly initRulesPerBlueprint: number;
  readonly formulaLength: number;
  readonly toolResultChars: number;
}

/**
 * The size limits the pet's tools and blueprints are held to, as constants a later task's Zod
 * schemas import rather than repeating as literals - the source `renderConsult`'s blueprint
 * summary and any future validator both read.
 */
export const LIMITS = {
  rawToolCallBytes: 40_000,
  specJsonChars: 24_000,
  specJsonDepth: 24,
  blueprintNodes: 40,
  blueprintNonSampleNodes: 15,
  blueprintDepth: 4,
  fieldsPerNode: 30,
  fieldsPerBlueprint: 80,
  viewsPerNode: 6,
  viewsPerBlueprint: 20,
  sampleEntries: 30,
  plannedWritesPerBuild: 80,
  entriesPerCreateEntries: 25,
  inputsPerBlueprint: 10,
  initRulesPerBlueprint: 100,
  formulaLength: 1024,
  toolResultChars: 16_000,
} as const satisfies CatalogLimits;

/** The two kinds of value a template input may collect. */
export const TEMPLATE_INPUT_TYPES = ['text', 'date'] as const satisfies readonly string[];

/** The five ways a blueprint's init rules may set a field when a template is applied. */
export const INIT_RULE_KINDS = [
  'keep',
  'clear',
  'set',
  'input',
  'relativeDate',
] as const satisfies readonly string[];

export interface RecurrenceRules {
  readonly frequencies: readonly string[];
  readonly intervalMin: number;
  readonly intervalMax: number;
}

/** What `RecurrenceSpec` accepts. */
export const RECURRENCE = {
  frequencies: ['daily', 'weekly', 'monthly', 'yearly'],
  intervalMin: 1,
  intervalMax: 366,
} as const satisfies RecurrenceRules;

export interface HabitRules {
  readonly frequencies: readonly string[];
}

/** What a blueprint node's `habit` settings accept. */
export const HABIT = {
  frequencies: ['daily', 'weekly'],
} as const satisfies HabitRules;

/**
 * The four things no pet operation may ever do, regardless of mode - enforced by construction
 * (no operation the pet can call publishes a link, deletes permanently, retypes or removes a
 * field, or deletes a view), and repeated here only so the model is told, not asked to infer it.
 */
export const NEVER_OPERATIONS = [
  'Publish a public link',
  'Delete anything permanently',
  'Remove or retype a field',
  'Delete a view',
] as const satisfies readonly string[];

export interface StructureOperationsByMode {
  readonly chat: readonly string[];
  readonly consult: readonly string[];
}

/**
 * The `nix_workspace` operations that build or extend structure from a `specJson` - as opposed to
 * the plain item operations (`create_note`, `set_properties`, ...) and the template operations
 * (`list_templates`, `read_template`, `apply_template`) - named once per mode so the catalog text
 * (`build.ts`) states them instead of a hand-typed sentence.
 *
 * Go's `workspaceTools()` enum is the operations' real source of truth; `catalog_test.go`'s
 * `TestCatalogNamesEveryOperationInItsMode` cross-checks this list against that enum so a
 * structure operation added to one and forgotten in the other fails a test instead of drifting.
 * Consult mode carries the same set for now; a later task (D.1b) grows it alongside the
 * consult-only tool enum (`validate_blueprint`, `build_blueprint`, `save_as_template`).
 */
export const STRUCTURE_OPERATIONS = {
  chat: ['create_structured', 'add_view', 'create_entries', 'add_fields', 'edit_form', 'set_recurrence'],
  consult: ['create_structured', 'add_view', 'create_entries', 'add_fields', 'edit_form', 'set_recurrence'],
} as const satisfies StructureOperationsByMode;
