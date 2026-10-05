import { z } from 'zod';
import {
  CONSULT_ONLY_OPERATION_NAMES,
  READ_ONLY_OPERATION_NAMES,
  WORKSPACE_OPERATIONS,
} from '@nix/structure-spec';

const optionalId = z.union([z.literal(''), z.uuid()]);
export const workspaceToolSchema = z
  .object({
    // Sourced from @nix/structure-spec's WORKSPACE_OPERATIONS (packages/structure-spec/src/
    // catalog/tables.ts), which is also what the pet's typed nix_<operation> tools
    // (buildPetTools) and the Go worker's generated tools-chat.json/tools-consult.json are built
    // from, so this flat enum cannot drift out of step with either.
    operation: z.enum(WORKSPACE_OPERATIONS),
    itemId: optionalId,
    parentId: optionalId,
    title: z.string().max(240),
    markdown: z.string().max(16000),
    query: z.string().max(240),
    propertiesJson: z.string().max(8000),
    specJson: z.string().max(24000).default(''),
  })
  .strict()
  .superRefine((args, context) => {
    const required = (
      field: 'itemId' | 'parentId' | 'title' | 'markdown' | 'query' | 'specJson',
    ) => {
      if (!args[field].trim())
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} is required for ${args.operation}.`,
        });
    };
    const NO_ITEM_ID_REQUIRED = [
      'create_note',
      'list_items',
      'search',
      'list_templates',
      'create_structured',
      'create_entries',
      'validate_blueprint',
      'build_blueprint',
    ];
    if (!NO_ITEM_ID_REQUIRED.includes(args.operation)) required('itemId');
    if (
      [
        'create_note',
        'rename_item',
        'apply_template',
        'create_structured',
        'save_as_template',
      ].includes(args.operation)
    )
      required('title');
    if (args.operation === 'append_note') required('markdown');
    if (args.operation === 'search') required('query');
    if (args.operation === 'create_entries') required('parentId');
    if (
      [
        'create_structured',
        'add_view',
        'create_entries',
        'add_fields',
        'edit_form',
        'set_recurrence',
      ].includes(args.operation)
    ) {
      if (!args.specJson.trim()) {
        required('specJson');
      } else {
        try {
          const parsed: unknown = JSON.parse(args.specJson);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
            throw new Error('specJson must be a JSON object.');
        } catch {
          context.addIssue({
            code: 'custom',
            path: ['specJson'],
            message: 'Provide a JSON object in specJson.',
          });
        }
      }
    }
    if (
      args.operation === 'validate_blueprint' ||
      args.operation === 'build_blueprint' ||
      args.operation === 'save_as_template'
    ) {
      if (!args.specJson.trim() && args.operation !== 'save_as_template') required('specJson');
      else if (args.specJson.trim()) {
        try {
          const parsed: unknown = JSON.parse(args.specJson);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
            throw new Error('specJson must be a JSON object.');
        } catch {
          context.addIssue({
            code: 'custom',
            path: ['specJson'],
            message: 'Provide a JSON object in specJson.',
          });
        }
      }
    }
    if (args.specJson.trim() && args.markdown.trim()) {
      context.addIssue({
        code: 'custom',
        path: ['markdown'],
        message: 'markdown must be empty when specJson is used.',
      });
    }
    if (args.operation === 'set_properties') {
      try {
        z.record(z.string().max(160), z.unknown()).parse(JSON.parse(args.propertiesJson));
      } catch {
        context.addIssue({
          code: 'custom',
          path: ['propertiesJson'],
          message: 'Provide a JSON object of property values.',
        });
      }
    }
  });

export type WorkspaceToolArgs = z.infer<typeof workspaceToolSchema>;

/** A local preflight refusal with safe copy, before any mutation is attempted. */
export class WorkspaceToolRefusal extends Error {}

/** The operations the executor never writes through. `runWorkspaceTool`'s
 * `WorkspaceToolOutcome.readOnly` is derived from this set. Sourced from @nix/structure-spec's
 * READ_ONLY_OPERATION_NAMES, the same list `buildPetTools`' tool descriptions read. */
export const READ_ONLY_OPERATIONS: ReadonlySet<WorkspaceToolArgs['operation']> = new Set(
  READ_ONLY_OPERATION_NAMES,
);

/** Operations only offered in consult mode. Sourced from @nix/structure-spec's
 * CONSULT_ONLY_OPERATION_NAMES, the same list `buildPetTools` filters chat mode's tools by. */
export const CONSULT_ONLY_OPERATIONS: ReadonlySet<WorkspaceToolArgs['operation']> = new Set(
  CONSULT_ONLY_OPERATION_NAMES,
);
