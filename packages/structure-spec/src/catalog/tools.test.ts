import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import type { StructureProperty, StructureView } from '../types.js';
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
import { validateBlueprint } from '../blueprint/validate.js';
import { validateSpec } from '../validate/spec.js';
import { buildPetTools, normalizeForCodex } from './tools.js';
import { CONSULT_ONLY_OPERATION_NAMES, WORKSPACE_OPERATIONS } from './tables.js';
import { flattenToolExample, TOOL_EXAMPLES } from './tool-examples.js';

/**
 * The Codex 0.153.4 dynamic-tool byte budget (see "Codex 0.153.4 facts",
 * `docs/plans/pet-speed-accuracy-plan.md`): a schema at or under this size is never compacted.
 */
const CODEX_SCHEMA_BUDGET = 4800;

function toolNames(mode: 'chat' | 'consult'): string[] {
  return buildPetTools(mode).map((tool) => tool.name);
}

describe('buildPetTools', () => {
  it('names every tool nix_<operation>, offering every operation in consult and omitting the three consult-only ones in chat', () => {
    const consultOnly = new Set<string>(CONSULT_ONLY_OPERATION_NAMES);
    const chatOperations = WORKSPACE_OPERATIONS.filter((operation) => !consultOnly.has(operation));

    expect(toolNames('chat')).toEqual(chatOperations.map((operation) => `nix_${operation}`));
    expect(toolNames('consult')).toEqual(WORKSPACE_OPERATIONS.map((operation) => `nix_${operation}`));
  });

  it('offers exactly one tool per operation, with no duplicates', () => {
    for (const mode of ['chat', 'consult'] as const) {
      const names = toolNames(mode);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('every tool has a non-empty description and a well-formed object inputSchema', () => {
    for (const mode of ['chat', 'consult'] as const) {
      for (const tool of buildPetTools(mode)) {
        expect(tool.description.length).toBeGreaterThan(0);
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.inputSchema.additionalProperties).toBe(false);
        expect(Array.isArray(tool.inputSchema.required)).toBe(true);
        expect(typeof tool.inputSchema.properties).toBe('object');
      }
    }
  });

  it('keeps every tool schema at or under the Codex 4800-byte budget once normalized', () => {
    const sizes: Record<string, number> = {};
    for (const mode of ['chat', 'consult'] as const) {
      for (const tool of buildPetTools(mode)) {
        const size = JSON.stringify(normalizeForCodex(tool.inputSchema)).length;
        sizes[`${mode}:${tool.name}`] = size;
        expect(size, `${mode} ${tool.name} is ${String(size)} bytes, want <= ${String(CODEX_SCHEMA_BUDGET)}`).toBeLessThanOrEqual(
          CODEX_SCHEMA_BUDGET,
        );
      }
    }
    // nix_validate_blueprint and nix_build_blueprint carry the largest schema in the catalog (the
    // recursive blueprint tree) - printed here as a record of the measured size after L1.2's
    // reduction (omitting the interactive_form view kind's `form` detail from the advertised
    // blueprint schema only; blueprintSchema itself, and what validateBlueprint accepts, is
    // unchanged). Before that reduction the wrapped tool was over budget (5823 bytes for the
    // blueprint sub-schema alone, per the plan's own measurement).
    expect(sizes['consult:nix_validate_blueprint']).toBeLessThanOrEqual(CODEX_SCHEMA_BUDGET);
    expect(sizes['consult:nix_build_blueprint']).toBeLessThanOrEqual(CODEX_SCHEMA_BUDGET);
  });

  it("generates each spec parameter from the exact schema object run.ts parses with (import identity)", () => {
    const bySpecSchema: [string, string, z.ZodType][] = [
      ['create_structured', 'spec', structuredSpecSchema],
      ['add_view', 'spec', viewSetupSpecSchema],
      ['create_entries', 'spec', entriesSpecSchema],
      ['add_fields', 'spec', fieldsSpecSchema],
      ['edit_form', 'spec', formEditSpecSchema],
      ['set_recurrence', 'spec', recurrenceSpecSchema],
      ['apply_template', 'spec', applySpecSchema],
      ['save_as_template', 'spec', saveSpecSchema],
    ];
    const consultTools = new Map(buildPetTools('consult').map((tool) => [tool.name, tool]));
    for (const [operation, property, schema] of bySpecSchema) {
      const tool = consultTools.get(`nix_${operation}`);
      expect(tool, `nix_${operation} is missing`).toBeDefined();
      const expected = normalizeForCodex(
        z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any', cycles: 'ref' }),
      );
      const inputSchema = tool?.inputSchema as { properties: Record<string, unknown> } | undefined;
      expect(inputSchema?.properties[property]).toEqual(expected);
    }
  });

  it("omits the interactive_form view kind's form detail from the blueprint tools only, never from add_view or edit_form", () => {
    const consultTools = new Map(buildPetTools('consult').map((tool) => [tool.name, tool]));
    const addView = consultTools.get('nix_add_view');
    const editForm = consultTools.get('nix_edit_form');
    const buildBlueprint = consultTools.get('nix_build_blueprint');
    const validateBlueprintTool = consultTools.get('nix_validate_blueprint');
    expect(addView).toBeDefined();
    expect(editForm).toBeDefined();
    expect(buildBlueprint).toBeDefined();
    expect(validateBlueprintTool).toBeDefined();

    // add_view and edit_form keep the interactive_form view kind's own form detail (a
    // paragraph block, part of formSpecSchema's block union) in full.
    expect(JSON.stringify(addView?.inputSchema)).toContain('"paragraph"');
    expect(JSON.stringify(editForm?.inputSchema)).toContain('"paragraph"');

    // The blueprint tools still name interactive_form as a valid view kind; they just no
    // longer carry that kind's own form (pages/blocks/conditions) detail.
    for (const tool of [buildBlueprint, validateBlueprintTool]) {
      const json = JSON.stringify(tool?.inputSchema);
      expect(json).toContain('interactive_form');
      expect(json).not.toContain('"paragraph"');
    }
  });
});

describe('flattenToolExample (TS reference implementation)', () => {
  for (const operation of WORKSPACE_OPERATIONS) {
    it(`flattens the ${operation} example into the operation and every required flat field`, () => {
      const example = TOOL_EXAMPLES[operation];
      const flat = flattenToolExample(operation, example);
      expect(flat.operation).toBe(operation);
      for (const key of ['itemId', 'parentId', 'title', 'markdown', 'query', 'propertiesJson', 'specJson'] as const) {
        expect(typeof flat[key]).toBe('string');
      }
    });
  }

  it('maps templateId to itemId', () => {
    const flat = flattenToolExample('read_template', TOOL_EXAMPLES.read_template);
    expect(flat.itemId).toBe(TOOL_EXAMPLES.read_template.templateId);
  });

  it('marshals properties, spec and blueprint to canonical JSON strings', () => {
    const flat = flattenToolExample('set_properties', TOOL_EXAMPLES.set_properties);
    expect(JSON.parse(flat.specJson || '{}')).toEqual({});
    expect(JSON.parse(flat.propertiesJson)).toEqual(TOOL_EXAMPLES.set_properties.properties);

    const structured = flattenToolExample('create_structured', TOOL_EXAMPLES.create_structured);
    expect(JSON.parse(structured.specJson)).toEqual(TOOL_EXAMPLES.create_structured.spec);
  });
});

describe('every tool example is accepted by the same validator run.ts calls', () => {
  const statusProperty: StructureProperty = {
    key: 'status',
    label: 'Status',
    type: 'select',
    options: ['To read', 'Reading', 'Done'],
    required: false,
  };
  const dueDateProperty: StructureProperty = {
    key: 'due_date',
    label: 'Due date',
    type: 'due_date',
    options: [],
    required: false,
  };
  function interactiveFormView(id: string): StructureView {
    return {
      id,
      name: 'Intake',
      kind: 'interactive_form',
      columns: ['title'],
      groupBy: null,
      groupOrder: [],
      dateProperty: null,
      sortBy: null,
      sortDescending: false,
      mode: null,
      coverProperty: null,
      endDateProperty: null,
      cardSize: null,
      layout: null,
      filters: [],
      interactiveForm: {
        pages: [
          {
            id: 'p1',
            title: 'Details',
            description: null,
            visibleWhen: [],
            blocks: [
              {
                id: 'b1',
                kind: 'field',
                propertyKey: 'status',
                text: 'Status',
                help: null,
                required: false,
                identityRole: null,
                visibleWhen: [],
              },
            ],
          },
        ],
        titleMode: 'generated',
        titleFieldBlockId: null,
        confirmationTitle: '',
        confirmationMessage: '',
      },
    };
  }

  it('create_structured', () => {
    const example = TOOL_EXAMPLES.create_structured as { spec: unknown };
    const report = validateSpec('create_structured', example.spec, {
      inheritedFields: [],
      today: '2026-09-27',
    });
    expect(report.ok, JSON.stringify(report.problems)).toBe(true);
  });

  it('add_view', () => {
    const example = TOOL_EXAMPLES.add_view as { spec: unknown };
    const report = validateSpec('add_view', example.spec, {
      inheritedFields: [],
      existing: { declared: [statusProperty], inherit: true, views: [] },
      today: '2026-09-27',
    });
    expect(report.ok, JSON.stringify(report.problems)).toBe(true);
  });

  it('add_fields', () => {
    const example = TOOL_EXAMPLES.add_fields as { spec: unknown };
    const report = validateSpec('add_fields', example.spec, {
      inheritedFields: [],
      existing: { declared: [], inherit: true, views: [] },
      today: '2026-09-27',
    });
    expect(report.ok, JSON.stringify(report.problems)).toBe(true);
  });

  it('edit_form', () => {
    const example = TOOL_EXAMPLES.edit_form as { spec: { viewId: string } };
    const report = validateSpec('edit_form', example.spec, {
      inheritedFields: [],
      existing: {
        declared: [statusProperty],
        inherit: true,
        views: [interactiveFormView(example.spec.viewId)],
      },
      today: '2026-09-27',
    });
    expect(report.ok, JSON.stringify(report.problems)).toBe(true);
  });

  it('set_recurrence', () => {
    const example = TOOL_EXAMPLES.set_recurrence as { spec: unknown };
    const report = validateSpec('set_recurrence', example.spec, {
      inheritedFields: [],
      existing: { declared: [dueDateProperty], inherit: true, views: [] },
      itemValues: { due_date: '2026-10-01' },
      today: '2026-09-27',
    });
    expect(report.ok, JSON.stringify(report.problems)).toBe(true);
  });

  it('validate_blueprint and build_blueprint share one blueprint that validateBlueprint accepts', () => {
    const example = TOOL_EXAMPLES.validate_blueprint as { blueprint: unknown };
    const parsed = blueprintSchema.parse(example.blueprint);
    const report = validateBlueprint(parsed, { inheritedFields: [], today: '2026-09-27' });
    expect(report.ok, JSON.stringify(report.problems)).toBe(true);
  });
});
