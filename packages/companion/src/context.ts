import { items, structure, templates, views, type TemplatePreflight } from '@nix/api-client';
import { applySpecSchema, saveSpecSchema } from '@nix/structure-spec';
import type {
  Problem,
  StructureProperty,
  StructureView,
  ValidationReport,
} from '@nix/structure-spec';
import { z } from 'zod';
import type { BodyEdit, BodyEditPlan, CompanionPorts } from './ports.js';
import type { WorkspaceToolArgs } from './tool-args.js';
import { checkItem, structureFingerprint, type StructureFingerprint } from './guards.js';
import { WorkspaceToolRefusal } from './tool-args.js';
import { validateBlueprint } from '@nix/structure-spec';
import { findSandbox } from './blueprint/sandbox.js';

/** How far up the tree the destination path is walked before it is simply truncated: enough for
 * a preview to read as a breadcrumb, never a full-workspace crawl. */
const MAX_DESTINATION_DEPTH = 8;

export interface PreviewDestination {
  title: string;
  /** Ancestor titles only, root-most first, stopping at `MAX_DESTINATION_DEPTH`. */
  path: string[];
}

export interface PreviewExisting {
  declared: StructureProperty[];
  inherit: boolean;
  effective: StructureProperty[];
  views: StructureView[];
}

/** Everything a card (or `run.ts`, recomputing the same thing at execution time) needs to
 * preview or fence a structure write, gathered from fresh, `forceRefresh: true` reads made with
 * the caller's own client - never sent to the model (architecture 1.2). */
export interface PreviewContext {
  destination: PreviewDestination;
  existing?: PreviewExisting;
  itemValues?: Record<string, unknown>;
  inheritedFields: StructureProperty[];
  fingerprint: StructureFingerprint;
  preflight?: TemplatePreflight;
  problems: Problem[];
  warnings?: Problem[];
  blueprintReport?: ValidationReport;
  sandboxExists?: boolean;
  sourceItemCount?: number;
  sampleCount?: number;
  sourceTitle?: string;
  captureFingerprint?: string;
  /** For a body edit (`replace_section`, `replace_passage`): what it would change. Absent when the
   * edit cannot be placed, in which case `problems` says why. */
  bodyEdit?: BodyEditPlan;
}

/** The body edit a `replace_section` or `replace_passage` call names, from its flat arguments:
 * `query` is the heading or the text to find, `markdown` the new section or replacement text. */
export function bodyEditOf(args: WorkspaceToolArgs): BodyEdit | undefined {
  if (args.operation === 'replace_section')
    return { kind: 'section', heading: args.query, markdown: args.markdown };
  if (args.operation === 'replace_passage')
    return { kind: 'passage', find: args.query, replace: args.markdown };
  return undefined;
}

const formConditionSchema = z.object({
  fieldBlockId: z.string(),
  operator: z.string(),
  value: z.string().nullable(),
});
const formBlockSchema = z.object({
  id: z.string(),
  kind: z.string(),
  propertyKey: z.string().nullable(),
  text: z.string(),
  help: z.string().nullable(),
  required: z.boolean(),
  identityRole: z.string().nullable(),
  visibleWhen: z.array(formConditionSchema),
});
const interactiveFormSchema = z.object({
  pages: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      description: z.string().nullable(),
      visibleWhen: z.array(formConditionSchema),
      blocks: z.array(formBlockSchema),
    }),
  ),
  titleMode: z.string(),
  titleFieldBlockId: z.string().nullable(),
  confirmationTitle: z.string(),
  confirmationMessage: z.string(),
});
const viewDetailSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  columns: z
    .array(z.string())
    .nullish()
    .transform((value) => value ?? []),
  groupBy: z.string().nullable().default(null),
  groupOrder: z
    .array(z.string())
    .nullish()
    .transform((value) => value ?? []),
  dateProperty: z.string().nullable().default(null),
  sortBy: z.string().nullable().default(null),
  sortDescending: z.boolean().default(false),
  mode: z.string().nullable().default(null),
  coverProperty: z.string().nullable().default(null),
  endDateProperty: z.string().nullable().default(null),
  cardSize: z.string().nullable().default(null),
  layout: z.string().nullable().default(null),
  filters: z
    .array(z.object({ property: z.string(), operator: z.string(), value: z.string() }))
    .default([]),
  habitWidgets: z
    .array(
      z.object({
        id: z.string(),
        kind: z.enum(['completion', 'quantity', 'heatmap']),
        habitId: z.string(),
        from: z.string(),
        to: z.string(),
      }),
    )
    .default([]),
  measure: z.string().nullable().default(null),
  measureProperty: z.string().nullable().default(null),
  companionViewId: z.string().nullable().default(null),
  companionPlacement: z.enum(['below', 'beside']).nullable().default(null),
  interactiveForm: interactiveFormSchema.nullable().default(null),
}) satisfies z.ZodType<StructureView>;

/** The fields this item inherits from its ancestors alone, backed out of the effective schema by
 * removing whatever the item declares itself - `EffectiveSchema` only carries the merged result
 * and the item's own declared set, not the inherited-only remainder `ValidationContext` wants. */
function inheritedOnly(
  effective: readonly StructureProperty[],
  declared: readonly StructureProperty[],
): StructureProperty[] {
  const declaredKeys = new Set(declared.map((property) => property.key));
  return effective.filter((property) => !declaredKeys.has(property.key));
}

async function destinationPath(
  ports: CompanionPorts,
  workspaceId: string,
  parentId: string,
  signal: AbortSignal,
): Promise<PreviewDestination> {
  const titles: string[] = [];
  let current: string | null = parentId;
  for (let depth = 0; depth < MAX_DESTINATION_DEPTH && current; depth += 1) {
    const item = await checkItem(ports, workspaceId, current, signal);
    titles.unshift(item.title);
    current = item.parentId;
  }
  return { title: titles.at(-1) ?? 'Workspace root', path: titles };
}

async function itemDestination(
  ports: CompanionPorts,
  workspaceId: string,
  itemId: string,
  signal: AbortSignal,
): Promise<PreviewDestination> {
  const item = await checkItem(ports, workspaceId, itemId, signal);
  const parent = item.parentId
    ? await destinationPath(ports, workspaceId, item.parentId, signal)
    : { title: 'Workspace root', path: [] };
  return { title: item.title, path: [...parent.path, item.title] };
}

/**
 * Loads the fresh, browser-only context a structure operation is previewed or fenced against:
 * the target's (or destination's) current schema and views, and - for `apply_template` - the
 * preflight Core would run before applying it. Every id `args` names is checked against
 * `workspaceId` before anything else is read.
 *
 * Called twice for one write: once by the card before approval, to render the preview, and once
 * more by `run.ts` at execution time, to compare the fresh `fingerprint` against the one the
 * preview rendered (the `fence` in `RunOptions`).
 */
export async function loadPreviewContext(
  ports: CompanionPorts,
  workspaceId: string,
  args: WorkspaceToolArgs,
  signal: AbortSignal,
): Promise<PreviewContext> {
  const requestOptions = { signal, forceRefresh: true };

  if (args.operation === 'save_as_template') {
    const spec = saveSpecSchema.parse(args.specJson.trim() ? JSON.parse(args.specJson) : {});
    // Core hashes the complete source for the approval fence and the projected tree for
    // capture after Sample: descendants are temporarily trashed. Read both projections so
    // the card's count and sample note come from the same authoritative source snapshot.
    const projected = await ports.core.query(
      templates.previewTemplateCapture(workspaceId, args.itemId, true, true),
      requestOptions,
    );
    const full = await ports.core.query(
      templates.previewTemplateCapture(workspaceId, args.itemId, true, false),
      requestOptions,
    );
    if (projected.fingerprint !== full.fingerprint)
      throw new WorkspaceToolRefusal(
        'The source changed while preparing the preview. Refresh and try again.',
      );
    return {
      destination: { title: full.sourceTitle, path: [full.sourceTitle] },
      inheritedFields: [],
      fingerprint: full.fingerprint,
      captureFingerprint: spec.includeSamples
        ? full.captureFingerprint
        : projected.captureFingerprint,
      problems: [],
      sourceTitle: full.sourceTitle,
      sourceItemCount: spec.includeSamples ? full.itemCount : projected.itemCount,
      sampleCount: full.itemCount - projected.itemCount,
    };
  }

  if (args.operation === 'build_blueprint') {
    const parent = args.parentId
      ? await checkItem(ports, workspaceId, args.parentId, signal)
      : null;
    const sandbox = parent === null ? await findSandbox(ports, workspaceId, signal) : null;
    const destination = parent
      ? await destinationPath(ports, workspaceId, parent.id, signal)
      : sandbox
        ? await destinationPath(ports, workspaceId, sandbox.id, signal)
        : { title: 'Pet drafts', path: ['Pet drafts'] };
    const schema = parent
      ? await ports.core.query(structure.effectiveSchema(parent.id), requestOptions)
      : {
          properties: [] as StructureProperty[],
          declared: [] as StructureProperty[],
          inherit: true,
        };
    const spec: unknown = args.specJson ? JSON.parse(args.specJson) : {};
    const report = validateBlueprint(spec, {
      inheritedFields: schema.properties,
      today: ports.clock.today(),
    });
    return {
      destination,
      inheritedFields: schema.properties,
      // A same-title sandbox can be deleted and replaced between preview and approval.
      // Bind the fence to its item identity as well as the destination's schema.
      fingerprint: JSON.stringify([
        parent?.id ?? sandbox?.id ?? null,
        structureFingerprint({ declared: schema.properties }, []),
      ]),
      problems: report.problems,
      warnings: report.warnings,
      blueprintReport: report,
      sandboxExists: sandbox !== null,
    };
  }

  if (args.operation === 'apply_template') {
    // Validate both externally supplied identities before any dependent reads. Template
    // membership is checked through the workspace catalog; the destination is checked before
    // walking its ancestors or preflighting against it.
    const catalog = await ports.core.query(templates.listTemplates(workspaceId), requestOptions);
    if (!catalog.templates.some((template) => template.id === args.itemId))
      throw new WorkspaceToolRefusal('The template is outside this workspace. No action was run.');
    if (args.parentId) await checkItem(ports, workspaceId, args.parentId, signal);
    const destination = args.parentId
      ? await destinationPath(ports, workspaceId, args.parentId, signal)
      : { title: 'Workspace root', path: [] };
    const preflight = await ports.core.execute(
      templates.preflightTemplate(args.itemId, {
        mode: 'create',
        parentItemId: args.parentId || null,
        title: args.title,
        inputs: applySpecSchema.parse(args.specJson ? JSON.parse(args.specJson) : {}).inputs,
      }),
      requestOptions,
    );
    return {
      destination,
      inheritedFields: [],
      fingerprint: structureFingerprint({ declared: [] }, []),
      preflight,
      problems: [],
    };
  }

  const edit = bodyEditOf(args);
  if (edit !== undefined) {
    const item = await checkItem(ports, workspaceId, args.itemId, signal);
    const destination = await itemDestination(ports, workspaceId, item.id, signal);
    const refused = (path: string, message: string, modelMessage: string): PreviewContext => ({
      destination,
      inheritedFields: [],
      fingerprint: '',
      problems: [{ path, code: 'body_edit_refused', message, modelMessage }],
    });
    if (item.type !== 'note')
      return refused(
        'itemId',
        'Only a note’s text can be edited this way.',
        'Only a note body can be edited.',
      );
    try {
      const plan = await ports.bodies.planEdit(item.id, edit, signal);
      return {
        destination,
        inheritedFields: [],
        fingerprint: plan.fingerprint,
        problems: [],
        bodyEdit: plan,
      };
    } catch (error) {
      if (error instanceof WorkspaceToolRefusal)
        return refused(
          edit.kind === 'section' ? 'heading' : 'find',
          error.ownerMessage ?? error.message,
          error.message,
        );
      throw error;
    }
  }

  if (args.operation === 'create_structured' || args.operation === 'create_entries') {
    const destination = args.parentId
      ? await destinationPath(ports, workspaceId, args.parentId, signal)
      : { title: 'Workspace root', path: [] };
    const parentSchema = args.parentId
      ? await ports.core.query(structure.effectiveSchema(args.parentId), requestOptions)
      : {
          properties: [] as StructureProperty[],
          declared: [] as StructureProperty[],
          inherit: true,
        };
    return {
      destination,
      inheritedFields: parentSchema.properties,
      fingerprint: structureFingerprint({ declared: parentSchema.properties }, []),
      problems: [],
    };
  }

  // Legacy item operations are workspace-checked here and intentionally receive no structure
  // reads. This prevents a newly supported or future legacy operation from falling through into
  // schema/view access with a cross-workspace id.
  if (
    !['add_view', 'read_structure', 'add_fields', 'edit_form', 'set_recurrence'].includes(
      args.operation,
    )
  ) {
    if (args.itemId && !['restore_item', 'read_template'].includes(args.operation))
      await checkItem(ports, workspaceId, args.itemId, signal);
    const destination = args.parentId
      ? await destinationPath(ports, workspaceId, args.parentId, signal)
      : args.operation !== 'move_item' &&
          args.itemId &&
          !['restore_item', 'read_template'].includes(args.operation)
        ? await itemDestination(ports, workspaceId, args.itemId, signal)
        : { title: 'Workspace root', path: [] };
    return {
      destination,
      inheritedFields: [],
      fingerprint: structureFingerprint({ declared: [] }, []),
      problems: [],
    };
  }

  // Item structure operations: an existing item's own schema, views, and values.
  const destination = await itemDestination(ports, workspaceId, args.itemId, signal);
  const [item, schema, containerViews] = await Promise.all([
    ports.core.query(items.itemById(args.itemId), requestOptions),
    ports.core.query(structure.effectiveSchema(args.itemId), requestOptions),
    ports.core.query(views.containerViewConfigurations(args.itemId), requestOptions),
  ]);
  const existingViews = containerViews.views.map((view) => viewDetailSchema.parse(view));
  return {
    destination,
    existing: {
      declared: schema.declared,
      inherit: schema.inherit,
      effective: schema.properties,
      views: existingViews,
    },
    itemValues: item.properties,
    inheritedFields: inheritedOnly(schema.properties, schema.declared),
    fingerprint: structureFingerprint({ declared: schema.declared }, existingViews),
    problems: [],
  };
}
