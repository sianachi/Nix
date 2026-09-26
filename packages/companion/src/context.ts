import { structure, templates, views, type TemplatePreflight } from '@nix/api-client';
import { applySpecSchema } from '@nix/structure-spec';
import type { Problem, StructureProperty, StructureView } from '@nix/structure-spec';
import type { CompanionPorts } from './ports.js';
import type { WorkspaceToolArgs } from './tool-args.js';
import { checkItem, structureFingerprint, type StructureFingerprint } from './guards.js';
import { WorkspaceToolRefusal } from './tool-args.js';

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
  effective: StructureProperty[];
  views: StructureView[];
}

/** Everything a card (or `run.ts`, recomputing the same thing at execution time) needs to
 * preview or fence a structure write, gathered from fresh, `forceRefresh: true` reads made with
 * the caller's own client - never sent to the model (architecture 1.2). */
export interface PreviewContext {
  destination: PreviewDestination;
  existing?: PreviewExisting;
  inheritedFields: StructureProperty[];
  fingerprint: StructureFingerprint;
  preflight?: TemplatePreflight;
  problems: Problem[];
  warnings?: Problem[];
}

/** A container view's identity only: enough to fence on and to satisfy `compileAddView`'s typed
 * context, which reads no more than `id` from each existing view. The full view configuration
 * (columns, grouping, its form) is not needed here - `read-structure.ts` reads it separately,
 * through the same endpoint, for its own richer preview. */
function viewIdentity(summary: { id: string; name: string; kind: string }): StructureView {
  return {
    id: summary.id,
    name: summary.name,
    kind: summary.kind,
    columns: [],
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
  };
}

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
  if (!['add_view', 'read_structure', 'apply_template'].includes(args.operation)) {
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

  // read_structure and add_view: an existing item's own schema and views.
  const destination = await itemDestination(ports, workspaceId, args.itemId, signal);
  const [schema, containerViews] = await Promise.all([
    ports.core.query(structure.effectiveSchema(args.itemId), requestOptions),
    ports.core.query(views.containerViews(args.itemId), requestOptions),
  ]);
  const existingViews = containerViews.views.map(viewIdentity);
  return {
    destination,
    existing: { declared: schema.declared, effective: schema.properties, views: existingViews },
    inheritedFields: inheritedOnly(schema.properties, schema.declared),
    fingerprint: structureFingerprint({ declared: schema.declared }, existingViews),
    problems: [],
  };
}
