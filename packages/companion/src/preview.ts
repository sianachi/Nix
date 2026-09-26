import type { TemplatePreflight } from '@nix/api-client';
import {
  compileAddView,
  compileAddFields,
  compileCreateStructured,
  compileEditForm,
  compileEntries,
  compileRecurrence,
  describeSteps,
  entriesSpecSchema,
  fieldsSpecSchema,
  formEditSpecSchema,
  recurrenceSpecSchema,
  structuredSpecSchema,
  validateSpec,
  viewSetupSpecSchema,
  type DescribeContext,
  type PreviewModel,
  type Step,
  type ValidationContext,
} from '@nix/structure-spec';
import type { Problem } from '@nix/structure-spec';
import type { PreviewContext } from './context.js';
export type { PreviewContext } from './context.js';
import { READ_ONLY_OPERATIONS, type WorkspaceToolArgs } from './tool-args.js';

/** `WorkspaceToolArgs` widened to the operations and `specJson` field added by task A.4. */
export type PreviewToolArgs = Omit<WorkspaceToolArgs, 'operation'> & {
  operation:
    | WorkspaceToolArgs['operation']
    | 'read_structure'
    | 'create_structured'
    | 'add_view'
    | 'create_entries'
    | 'add_fields'
    | 'edit_form'
    | 'set_recurrence';
  specJson: string;
};

type SpecOperation =
  | 'create_structured'
  | 'add_view'
  | 'create_entries'
  | 'add_fields'
  | 'edit_form'
  | 'set_recurrence';

/** The writes this executor never performs (architecture section 2.2's "never mapped to any operation" guard, restated for a person). Shown on every preview so approving one request never reads as approving more than the executor can do. */
const NEVER_DOES: readonly string[] = [
  'Publish a public link',
  'Delete anything permanently',
  'Remove or retype a field',
  'Delete a view',
];

const READ_ONLY_PREVIEW_OPERATIONS: ReadonlySet<string> = new Set([
  ...READ_ONLY_OPERATIONS,
  'read_structure',
]);

function emptyCounts(): PreviewModel['counts'] {
  return { items: 0, fields: 0, views: 0, entries: 0, writes: 0 };
}

function compileSpecSteps(
  operation: SpecOperation,
  raw: unknown,
  args: PreviewToolArgs,
  context: PreviewContext,
): Step[] {
  switch (operation) {
    case 'create_structured': {
      const spec = structuredSpecSchema.parse(raw);
      return compileCreateStructured(spec, {
        parentId: args.parentId || null,
        title: args.title,
        inheritedFields: context.inheritedFields,
      });
    }
    case 'add_view': {
      const spec = viewSetupSpecSchema.parse(raw);
      const existing = context.existing ?? {
        declared: [],
        effective: context.inheritedFields,
        views: [],
      };
      return compileAddView(spec, { itemId: args.itemId, existing });
    }
    case 'create_entries': {
      const spec = entriesSpecSchema.parse(raw);
      return compileEntries(spec, { parentId: args.parentId || null });
    }
    case 'add_fields': {
      const spec = fieldsSpecSchema.parse(raw);
      const existing = context.existing ?? {
        declared: [],
        inherit: true,
        effective: context.inheritedFields,
        views: [],
      };
      return compileAddFields(spec, { itemId: args.itemId, existing });
    }
    case 'edit_form': {
      const spec = formEditSpecSchema.parse(raw);
      const existing = context.existing ?? {
        declared: [],
        inherit: true,
        effective: context.inheritedFields,
        views: [],
      };
      const view = existing.views.find((candidate) => candidate.id === spec.viewId);
      if (view === undefined) throw new Error(`View "${spec.viewId}" does not exist on this item.`);
      return compileEditForm(spec, { itemId: args.itemId, existing, view });
    }
    case 'set_recurrence': {
      const spec = recurrenceSpecSchema.parse(raw);
      return compileRecurrence(spec, { itemId: args.itemId });
    }
  }
}

function describeSpecOperation(
  operation: SpecOperation,
  args: PreviewToolArgs,
  context: PreviewContext,
): PreviewModel {
  let raw: unknown;
  try {
    raw = JSON.parse(args.specJson);
  } catch {
    return {
      headline: 'I cannot run this request as written.',
      destination: context.destination,
      counts: emptyCounts(),
      tree: [],
      notes: [],
      warnings: [],
      problems: [
        { path: 'specJson', code: 'invalid_json', message: 'specJson is not valid JSON.' },
      ],
      neverDoes: NEVER_DOES.slice(),
    };
  }

  const validationContext: ValidationContext = {
    inheritedFields: [...context.inheritedFields],
    ...(context.existing
      ? {
          existing: {
            declared: [...context.existing.declared],
            inherit: context.existing.inherit,
            views: [...context.existing.views],
          },
        }
      : {}),
    ...(context.itemValues !== undefined ? { itemValues: context.itemValues } : {}),
    // ValidationContext.today is reserved for a relative-date check `validateSpec` does not yet
    // perform for these three operations; there is no real clock port on `PreviewContext` to read
    // it from, so this is left blank rather than guessed.
    today: '',
  };
  const report = validateSpec(operation, raw, validationContext);
  if (!report.ok) {
    return {
      headline: 'I cannot run this request as written.',
      destination: context.destination,
      counts: { ...emptyCounts(), views: report.stats.views, entries: report.stats.entries },
      tree: [],
      notes: [],
      warnings: report.warnings,
      problems: report.problems,
      neverDoes: NEVER_DOES.slice(),
    };
  }

  const steps = compileSpecSteps(operation, raw, args, context);
  const describeContext: DescribeContext = {
    destination: context.destination,
    ...(context.existing ? { existing: context.existing } : {}),
    problems: report.problems,
    warnings: report.warnings,
  };
  const model = describeSteps(steps, describeContext);
  return { ...model, neverDoes: NEVER_DOES.slice() };
}

function applyTemplateNotes(preflight: TemplatePreflight | undefined): string[] {
  if (preflight === undefined) return [];
  const notes = [
    `Adds ${String(preflight.additions.items)} items, ${String(preflight.additions.fields)} fields and ${String(preflight.additions.views)} views.`,
  ];
  if (preflight.conflicts.length > 0) {
    notes.push(`Conflicts: ${preflight.conflicts.join('; ')}.`);
  }
  return notes;
}

function applyTemplateProblems(preflight: TemplatePreflight | undefined): Problem[] {
  if (preflight === undefined || preflight.canApply) return [];
  return [
    {
      path: 'template',
      code: 'conflict',
      message: `This template cannot be applied here: ${preflight.conflicts.join('; ')}.`,
    },
  ];
}

/** Sentences kept byte-for-byte from `apps/web/src/pets/pet-work-tools.tsx`'s
 * `describeWorkspaceAction` (lines 226-255), with `read_structure` using the architecture's
 * structure-aware description. `list_templates` and `read_template` use this task card's copy. */
function legacyHeadline(args: PreviewToolArgs): string {
  switch (args.operation) {
    case 'list_items':
      return args.parentId
        ? 'I will list the items inside the linked destination to find what to work on.'
        : 'I will list the top-level items in this workspace to find what to work on.';
    case 'search':
      return `I will search this workspace for “${args.query}” to find matching items.`;
    case 'read_item':
      return 'I will read the linked item’s details and properties.';
    case 'read_note':
      return 'I will read the linked note’s content for context.';
    case 'read_structure':
      return "I will read the linked item's fields, views and how many children it has.";
    case 'create_note':
      return `I will create a note named “${args.title}” ${args.parentId ? 'inside the linked destination' : 'at the top level of this workspace'}${args.markdown ? ', with the content shown below' : ', with an empty body'}.`;
    case 'append_note':
      return 'I will add the content below to the end of the linked note, preserving its existing content.';
    case 'rename_item':
      return `I will rename the linked item to “${args.title}”.`;
    case 'move_item':
      return `I will move the linked item ${args.parentId ? 'inside the linked destination' : 'to the top level of this workspace'}.`;
    case 'set_properties':
      return 'I will update the linked item with the property values shown below, leaving other properties unchanged.';
    case 'trash_item':
      return 'I will move the linked item to Trash. It can be restored later.';
    case 'restore_item':
      return 'I will restore the linked item from Trash.';
    case 'list_templates':
      return 'I will list the templates this workspace can apply.';
    case 'read_template':
      return 'I will read the outline of the linked template.';
    case 'apply_template':
      return `I will create “${args.title}” from the linked template${args.parentId ? ' inside the linked destination' : ' at the top level of this workspace'}.`;
    case 'create_structured':
    case 'add_view':
    case 'create_entries':
    case 'add_fields':
    case 'edit_form':
    case 'set_recurrence':
      throw new Error(`${args.operation} is a spec operation and has no legacy headline.`);
  }
}

function describeLegacyOperation(args: PreviewToolArgs, context: PreviewContext): PreviewModel {
  const notes = args.operation === 'apply_template' ? applyTemplateNotes(context.preflight) : [];
  const templateProblems =
    args.operation === 'apply_template' ? applyTemplateProblems(context.preflight) : [];
  return {
    headline: legacyHeadline(args),
    destination: context.destination,
    counts: {
      ...emptyCounts(),
      writes: READ_ONLY_PREVIEW_OPERATIONS.has(args.operation) ? 0 : 1,
    },
    tree: [],
    notes,
    warnings: context.warnings ?? [],
    problems: [...context.problems, ...templateProblems],
    neverDoes: NEVER_DOES.slice(),
  };
}

/**
 * Describes one pending `nix_workspace` tool call as a `PreviewModel` (architecture section 7),
 * so the approval card (task A.6) and `nixctl pet tools run` (task 0.5, updated by A.6/A.7) render
 * exactly what will happen with no JSX and no raw JSON. A spec operation is validated and compiled
 * before it is described, so a request `validateSpec` refuses never reaches `describeSteps` - its
 * problems are surfaced directly instead.
 */
export function describeToolCall(args: PreviewToolArgs, context: PreviewContext): PreviewModel {
  switch (args.operation) {
    case 'create_structured':
    case 'add_view':
    case 'create_entries':
    case 'add_fields':
    case 'edit_form':
    case 'set_recurrence':
      return describeSpecOperation(args.operation, args, context);
    default:
      return describeLegacyOperation(args, context);
  }
}
