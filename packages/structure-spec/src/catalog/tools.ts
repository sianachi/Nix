import { z } from 'zod';

import { blueprintSchema } from '../blueprint/schema.js';
import {
  applySpecSchema,
  entriesSpecSchema,
  fieldsSpecSchema,
  formEditSpecSchema,
  recurrenceSpecSchema,
  saveSpecSchema,
  structuredSpecSchema,
  viewSetupSpecSchema,
} from '../spec/index.js';
import {
  CONSULT_ONLY_OPERATION_NAMES,
  WORKSPACE_OPERATIONS,
  type WorkspaceOperation,
} from './tables.js';

/**
 * Generates the model-facing typed tools straight from the same Zod schemas
 * `@nix/companion/run.ts` parses with, so a wrong guess about spec shape (a `name` where the
 * validator wants `label`, `properties` where it wants `values`, a `groupBy` on a `list` view)
 * fails at the provider's own argument-schema layer instead of costing a full round trip.
 *
 * The worker still flattens every call back into today's `{operation, itemId, parentId, title,
 * markdown, query, propertiesJson, specJson}` shape before it reaches `@nix/companion`; nothing
 * downstream of the worker changes.
 */

export type JsonObject = Record<string, unknown>;

export interface PetToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

/**
 * The JSON Schema keys Codex 0.153.4's dynamic-tool sanitizer keeps; every other key is dropped
 * before the schema ever reaches the model, and a boolean `true` sub-schema becomes a bare
 * string type (a `false` sub-schema has no stated replacement, so it is treated the same as "no
 * recognisable hint" and becomes `{}`, consistent with the sanitizer's fallback for a schema kind
 * it does not recognise). Keeping only these keys here - rather than trusting Codex to strip the
 * rest - is what lets the byte budget below be measured against the schema Codex actually uses,
 * not the fuller one Zod produces.
 */
const CODEX_SCHEMA_KEYS = new Set([
  '$ref',
  'type',
  'description',
  'enum',
  'items',
  'minItems',
  'properties',
  'required',
  'additionalProperties',
  'anyOf',
  'oneOf',
  'allOf',
]);

/**
 * Reduces an arbitrary JSON Schema (as `z.toJSONSchema` produces it) to exactly the shape
 * Codex 0.153.4 keeps for a dynamic tool's `inputSchema`. Every tool schema in this module is
 * normalized before it is measured or shipped, so the 4800-byte budget in `tools.test.ts` is the
 * budget Codex itself applies (see "Codex 0.153.4 facts" in
 * `docs/plans/pet-speed-accuracy-plan.md`), not a looser one this package might otherwise send.
 */
export function normalizeForCodex(schema: unknown): unknown {
  if (schema === true) return { type: 'string' };
  if (schema === false || schema === null || typeof schema !== 'object') return {};
  const input = schema as JsonObject;
  const output: JsonObject = {};

  if ('const' in input && !('enum' in input)) {
    output.enum = [input.const];
  }

  for (const key of Object.keys(input)) {
    if (key === 'const' || !CODEX_SCHEMA_KEYS.has(key)) continue;
    const value = input[key];
    if (key === 'items' || key === 'additionalProperties') {
      output[key] = typeof value === 'boolean' ? value : normalizeForCodex(value);
    } else if (key === 'properties') {
      const properties: JsonObject = {};
      for (const [propertyName, propertySchema] of Object.entries(value as JsonObject)) {
        properties[propertyName] = normalizeForCodex(propertySchema);
      }
      output[key] = properties;
    } else if (key === 'anyOf' || key === 'oneOf' || key === 'allOf') {
      output[key] = (value as unknown[]).map((entry) => normalizeForCodex(entry));
    } else {
      output[key] = value;
    }
  }

  const defsSource = (input.$defs ?? input.definitions) as JsonObject | undefined;
  if (defsSource) {
    const defs: JsonObject = {};
    for (const [defName, defSchema] of Object.entries(defsSource)) {
      defs[defName] = normalizeForCodex(defSchema);
    }
    output.$defs = defs;
  }

  return output;
}

function jsonSchemaOf(schema: z.ZodType): unknown {
  return normalizeForCodex(
    z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any', cycles: 'ref' }),
  );
}

function stringProperty(description?: string): JsonObject {
  return description === undefined ? { type: 'string' } : { type: 'string', description };
}

/**
 * The shape `run.ts` accepts for `set_properties`' values: a JSON object whose values are a
 * string, number, boolean, string array, or null - `run.ts` itself only checks `typeof ===
 * 'object'` (via `workspaceToolSchema`'s `propertiesJson`), so this is written out by hand rather
 * than derived from a Zod schema that does not exist for it.
 */
function propertiesValueProperty(): JsonObject {
  return {
    type: 'object',
    description: 'One or more property values, keyed by field key (see nix_read_structure).',
    additionalProperties: {
      anyOf: [
        { type: 'string' },
        { type: 'number' },
        { type: 'boolean' },
        { type: 'array', items: { type: 'string' } },
        { type: 'null' },
      ],
    },
  };
}

/**
 * Walks a normalized JSON Schema and removes the `interactive_form` view kind's `form` detail
 * (a full page/block/condition tree - see `formSpecSchema`) wherever it appears. Applied only to
 * the blueprint tool (L1.2 tactic 3): the same view schema is small enough to keep whole in
 * `add_view` and `edit_form`'s own tools, but repeated at every depth of a blueprint's recursive
 * node tree it is the single largest contributor to the schema's size (roughly 1790 of 5823
 * bytes before this reduction - measured with `z.toJSONSchema`'s default `reused: 'inline'`;
 * `reused: 'ref'` was tried first per L1.2's step 1 and made the schema larger, not smaller,
 * because Codex's normalized keys leave little duplication for `$ref` extraction to remove once
 * `pattern`/`minLength`/`maxLength` are already stripped - so this tactic is applied instead).
 * `blueprintSchema` itself is unchanged: a pet-authored `interactive_form` view still parses and
 * validates; the model is simply not shown that one kind's detail when designing a whole
 * structure from scratch, where `add_view`/`edit_form` are the tools for going deeper on a form
 * afterwards.
 */
function omitBlueprintInteractiveFormDetail(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((entry) => omitBlueprintInteractiveFormDetail(entry));
  }
  if (schema === null || typeof schema !== 'object') return schema;
  const node = schema as JsonObject;
  const properties = node.properties as JsonObject | undefined;
  if (properties) {
    const kind = properties.kind as { enum?: unknown[] } | undefined;
    if (
      kind &&
      Array.isArray(kind.enum) &&
      kind.enum.includes('interactive_form') &&
      'form' in properties
    ) {
      const rest = { ...properties };
      delete rest.form;
      node.properties = rest;
    }
  }
  for (const key of Object.keys(node)) {
    node[key] = omitBlueprintInteractiveFormDetail(node[key]);
  }
  return node;
}

function blueprintProperty(): JsonObject {
  return omitBlueprintInteractiveFormDetail(jsonSchemaOf(blueprintSchema)) as JsonObject;
}

function wrap(properties: JsonObject, required: readonly string[]): JsonObject {
  return {
    type: 'object',
    properties,
    required: [...required],
    additionalProperties: false,
  };
}

const ITEM_ID_DESCRIPTION =
  'The exact item UUID. Discover it with nix_list_items or nix_search first if not already known.';
const PARENT_ID_DESCRIPTION = 'The parent item UUID, or omit/empty to use the workspace root.';
const TEMPLATE_ID_DESCRIPTION = 'The template item UUID.';

interface ToolBuild {
  readonly description: string;
  readonly properties: JsonObject;
  readonly required: readonly string[];
}

/**
 * One entry per `WorkspaceOperation` (see `tables.ts`), in that same order. This is the mapping
 * table L1.1 describes: what a typed tool's own parameters are, and - by construction, since
 * `@nix/companion/run.ts` reads the identical flat shape regardless of how the argument arrived -
 * how each maps back onto it. A tool's own parameter names differ from the flat shape only where
 * that removes an ambiguity the flat shape lives with: `read_template` and `apply_template` take
 * `templateId`, not `itemId`, because the id they need is a template's, and `set_properties`,
 * `create_structured`, `add_view`, `create_entries`, `add_fields`, `edit_form`, `set_recurrence`,
 * `apply_template` and `save_as_template` take `properties`/`spec`/`blueprint` as a native JSON
 * value, not a JSON-encoded string.
 */
const TOOL_BUILDS: Readonly<Record<WorkspaceOperation, () => ToolBuild>> = {
  list_items: () => ({
    description:
      "List an item's direct children (id, title, type, whether it has children). Omit parentId to list the workspace root. Read-only; reads may run without a card; changes always ask for approval.",
    properties: { parentId: stringProperty(PARENT_ID_DESCRIPTION) },
    required: [],
  }),
  search: () => ({
    description:
      'Search this workspace by title or content. Read-only; reads may run without a card; changes always ask for approval.',
    properties: { query: stringProperty('What to search for.') },
    required: ['query'],
  }),
  read_item: () => ({
    description: "Read one item's id, title, type and workspace. Read-only.",
    properties: { itemId: stringProperty(ITEM_ID_DESCRIPTION) },
    required: ['itemId'],
  }),
  read_note: () => ({
    description: "Read a note's Markdown body. Read-only.",
    properties: { itemId: stringProperty(ITEM_ID_DESCRIPTION) },
    required: ['itemId'],
  }),
  read_structure: () => ({
    description:
      "Read an item's declared and effective fields, its views and its child count. Call this before proposing any structure change. Read-only.",
    properties: { itemId: stringProperty(ITEM_ID_DESCRIPTION) },
    required: ['itemId'],
  }),
  create_note: () => ({
    description:
      'Create a new note with title and markdown, under parentId (omit for the workspace root). Shown for approval before it runs.',
    properties: {
      title: stringProperty('The new note title.'),
      markdown: stringProperty('Markdown for the note body.'),
      parentId: stringProperty(PARENT_ID_DESCRIPTION),
    },
    required: ['title', 'markdown'],
  }),
  append_note: () => ({
    description: "Append Markdown to a note's body. Never replaces existing content.",
    properties: {
      itemId: stringProperty(ITEM_ID_DESCRIPTION),
      markdown: stringProperty('Markdown to append.'),
    },
    required: ['itemId', 'markdown'],
  }),
  rename_item: () => ({
    description: 'Rename an item. Never changes anything else about it.',
    properties: {
      itemId: stringProperty(ITEM_ID_DESCRIPTION),
      title: stringProperty('The new title.'),
    },
    required: ['itemId', 'title'],
  }),
  move_item: () => ({
    description:
      'Move an item under a new parent. Supply an empty parentId to move it to the workspace root.',
    properties: {
      itemId: stringProperty(ITEM_ID_DESCRIPTION),
      parentId: stringProperty(PARENT_ID_DESCRIPTION),
    },
    required: ['itemId', 'parentId'],
  }),
  set_properties: () => ({
    description: "Set one or more of an item's property values. Call nix_read_structure first.",
    properties: {
      itemId: stringProperty(ITEM_ID_DESCRIPTION),
      properties: propertiesValueProperty(),
    },
    required: ['itemId', 'properties'],
  }),
  trash_item: () => ({
    description: 'Move an item to trash. Recoverable with nix_restore_item; never permanent.',
    properties: { itemId: stringProperty(ITEM_ID_DESCRIPTION) },
    required: ['itemId'],
  }),
  restore_item: () => ({
    description: 'Restore a trashed item.',
    properties: { itemId: stringProperty(ITEM_ID_DESCRIPTION) },
    required: ['itemId'],
  }),
  create_structured: () => ({
    description:
      'Create a new item with a recipe, fields and views, under parentId (omit for the workspace root). Shown for approval before it runs.',
    properties: {
      title: stringProperty('The new item title.'),
      spec: jsonSchemaOf(structuredSpecSchema),
      parentId: stringProperty(PARENT_ID_DESCRIPTION),
    },
    required: ['title', 'spec'],
  }),
  add_view: () => ({
    description:
      "Add fields and views to an item's existing schema. Never removes or retypes a field, never deletes an existing view.",
    properties: {
      itemId: stringProperty(ITEM_ID_DESCRIPTION),
      spec: jsonSchemaOf(viewSetupSpecSchema),
    },
    required: ['itemId', 'spec'],
  }),
  create_entries: () => ({
    description: 'Create up to 25 child entries under parentId in one call.',
    properties: {
      parentId: stringProperty("The container item's UUID."),
      spec: jsonSchemaOf(entriesSpecSchema),
    },
    required: ['parentId', 'spec'],
  }),
  validate_blueprint: () => ({
    description:
      'Check a whole-structure design before building it. Never writes; returns the same problems nix_build_blueprint would refuse on. Design mode only.',
    properties: { blueprint: blueprintProperty() },
    required: ['blueprint'],
  }),
  add_fields: () => ({
    description:
      "Add up to 20 new fields to an item's existing schema. Never removes or retypes an existing field.",
    properties: {
      itemId: stringProperty(ITEM_ID_DESCRIPTION),
      spec: jsonSchemaOf(fieldsSpecSchema),
    },
    required: ['itemId', 'spec'],
  }),
  edit_form: () => ({
    description:
      'Replace one existing interactive form view, optionally adding new fields to the item at the same time.',
    properties: {
      itemId: stringProperty(ITEM_ID_DESCRIPTION),
      spec: jsonSchemaOf(formEditSpecSchema),
    },
    required: ['itemId', 'spec'],
  }),
  set_recurrence: () => ({
    description: 'Set or replace a recurring due-date rule on an item.',
    properties: {
      itemId: stringProperty(ITEM_ID_DESCRIPTION),
      spec: jsonSchemaOf(recurrenceSpecSchema),
    },
    required: ['itemId', 'spec'],
  }),
  list_templates: () => ({
    description:
      'List templates available in this workspace, optionally filtered by query. Read-only.',
    properties: { query: stringProperty('Optional filter text.') },
    required: [],
  }),
  read_template: () => ({
    description: "Read one template's details. Read-only.",
    properties: { templateId: stringProperty(TEMPLATE_ID_DESCRIPTION) },
    required: ['templateId'],
  }),
  apply_template: () => ({
    description:
      'Apply a template to create a new item under parentId (omit for the workspace root), filling any inputs the template declares. Shown for approval before it runs.',
    properties: {
      templateId: stringProperty(TEMPLATE_ID_DESCRIPTION),
      title: stringProperty('The new item title.'),
      parentId: stringProperty(PARENT_ID_DESCRIPTION),
      spec: jsonSchemaOf(applySpecSchema),
    },
    required: ['templateId', 'title'],
  }),
  build_blueprint: () => ({
    description:
      'Build a validated blueprint under Pet drafts, at parentId (omit for the workspace root). Call nix_validate_blueprint first and fix every problem it reports. Design mode only.',
    properties: {
      blueprint: blueprintProperty(),
      parentId: stringProperty('The parent item UUID, or omit to build under Pet drafts.'),
    },
    required: ['blueprint'],
  }),
  save_as_template: () => ({
    description:
      'Save an item and its children as a reusable template named title. Excludes descendants titled "Sample: ..." by default. Design mode only.',
    properties: {
      itemId: stringProperty('The source item UUID.'),
      title: stringProperty('The template name.'),
      spec: jsonSchemaOf(saveSpecSchema),
    },
    required: ['itemId', 'title'],
  }),
};

/**
 * One typed function tool per operation the given mode offers, each with an exact JSON Schema
 * generated from the Zod schema `@nix/companion/run.ts` parses with. Tool names are
 * `nix_<operation>`. Consult (Design mode) offers every operation; chat omits the three
 * consult-only ones.
 */
export function buildPetTools(mode: 'chat' | 'consult'): PetToolDefinition[] {
  const consultOnly = new Set<string>(CONSULT_ONLY_OPERATION_NAMES);
  const operations = WORKSPACE_OPERATIONS.filter(
    (operation) => mode === 'consult' || !consultOnly.has(operation),
  );
  return operations.map((operation) => {
    const build = TOOL_BUILDS[operation]();
    return {
      name: `nix_${operation}`,
      description: build.description,
      inputSchema: wrap(build.properties, build.required),
    };
  });
}
