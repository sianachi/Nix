import { z } from 'zod';

const optionalId = z.union([z.literal(''), z.uuid()]);
export const workspaceToolSchema = z
  .object({
    operation: z.enum([
      'list_items',
      'search',
      'read_item',
      'read_note',
      'read_schema',
      'create_note',
      'append_note',
      'rename_item',
      'move_item',
      'set_properties',
      'trash_item',
      'restore_item',
    ]),
    itemId: optionalId,
    parentId: optionalId,
    title: z.string().max(240),
    markdown: z.string().max(16000),
    query: z.string().max(240),
    propertiesJson: z.string().max(8000),
  })
  .strict()
  .superRefine((args, context) => {
    const required = (field: 'itemId' | 'title' | 'markdown' | 'query') => {
      if (!args[field].trim())
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} is required for ${args.operation}.`,
        });
    };
    if (!['create_note', 'list_items', 'search'].includes(args.operation)) required('itemId');
    if (['create_note', 'rename_item'].includes(args.operation)) required('title');
    if (args.operation === 'append_note') required('markdown');
    if (args.operation === 'search') required('query');
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
 * `WorkspaceToolOutcome.readOnly` is derived from this set. */
export const READ_ONLY_OPERATIONS: ReadonlySet<WorkspaceToolArgs['operation']> = new Set([
  'list_items',
  'search',
  'read_item',
  'read_note',
  'read_schema',
]);
