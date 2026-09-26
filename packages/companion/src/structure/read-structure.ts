import { items, structure, views } from '@nix/api-client';
import { isComputedType } from '@nix/structure-spec';
import { z } from 'zod';
import { checkItem } from '../guards.js';
import type { CompanionPorts } from '../ports.js';

/** `GET /items/{id}/views` returns the full `ViewResponse` shape on the wire; the api-client
 * resource narrows its parse to the fields a plain view listing needs (`ContainerViewConfigurations`),
 * but its per-view schema is a loose object, so the fields this preview wants (`groupBy`, `columns`,
 * the form outline) still arrive on each parsed value - just untyped. Re-parsing here, once, keeps
 * that read narrowly scoped to what this file actually uses instead of widening the shared
 * api-client type for every other caller of `views.containerViewConfigurations`. */
const viewDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  groupBy: z.string().nullable().default(null),
  dateProperty: z.string().nullable().default(null),
  columns: z.array(z.string()).nullable().default(null),
  interactiveForm: z
    .object({
      pages: z.array(
        z.object({
          title: z.string(),
          blocks: z.array(
            z.object({
              kind: z.string(),
              propertyKey: z.string().nullable().default(null),
            }),
          ),
        }),
      ),
    })
    .nullable()
    .default(null),
});

export interface ReadStructureField {
  key: string;
  label: string;
  type: string;
  options: string[];
  required: boolean;
  inherited: boolean;
  computed: boolean;
}

export interface ReadStructureFormPage {
  title: string;
  questions: string[];
}

export interface ReadStructureView {
  id: string;
  name: string;
  kind: string;
  groupBy: string | null;
  dateProperty: string | null;
  columns: string[] | null;
  form?: { pages: ReadStructureFormPage[] };
}

export interface ReadStructureResult {
  item: { id: string; title: string; type: string };
  fields: ReadStructureField[];
  views: ReadStructureView[];
  childCount: number | 'many';
}

/** Bounds the child-count check to at most two requests of one row each: the first row proves a
 * child exists, a second proves there is more than one, and neither walks the rest of the
 * container the way `client.paginate` run to completion would. */
async function boundedChildCount(
  ports: CompanionPorts,
  workspaceId: string,
  parentId: string,
  signal: AbortSignal,
): Promise<number | 'many'> {
  let count = 0;
  for await (const row of ports.core.paginate(
    items.listItems(workspaceId, { parentId, pageSize: 1 }),
    { signal, forceRefresh: true },
  )) {
    void row;
    count += 1;
    if (count >= 2) return 'many';
  }
  return count;
}

/** `read_structure`: the fields, views and a bounded child count of one item, in plain enough
 * shape for the model to decide what a container already has before proposing more. */
export async function readStructure(
  ports: CompanionPorts,
  workspaceId: string,
  itemId: string,
  signal: AbortSignal,
): Promise<ReadStructureResult> {
  const requestOptions = { signal, forceRefresh: true };
  const item = await checkItem(ports, workspaceId, itemId, signal);
  const [schema, containerViews, childCount] = await Promise.all([
    ports.core.query(structure.effectiveSchema(itemId), requestOptions),
    ports.core.query(views.containerViewConfigurations(itemId), requestOptions),
    boundedChildCount(ports, workspaceId, itemId, signal),
  ]);

  const declaredKeys = new Set(schema.declared.map((property) => property.key));
  const labelByKey = new Map(schema.properties.map((property) => [property.key, property.label]));

  const fields: ReadStructureField[] = schema.properties.map((property) => ({
    key: property.key,
    label: property.label,
    type: property.type,
    options: property.options,
    required: property.required,
    inherited: !declaredKeys.has(property.key),
    computed: isComputedType(property.type),
  }));

  const viewList: ReadStructureView[] = containerViews.views.map((raw) => {
    const view = viewDetailSchema.parse(raw);
    const form =
      view.interactiveForm !== null
        ? {
            pages: view.interactiveForm.pages.map((page) => ({
              title: page.title,
              questions: page.blocks
                .filter((block) => block.kind === 'field' && block.propertyKey !== null)
                .map((block) => labelByKey.get(block.propertyKey ?? '') ?? block.propertyKey ?? ''),
            })),
          }
        : undefined;
    return {
      id: view.id,
      name: view.name,
      kind: view.kind,
      groupBy: view.groupBy,
      dateProperty: view.dateProperty,
      columns: view.columns,
      ...(form ? { form } : {}),
    };
  });

  return {
    item: { id: item.id, title: item.title, type: item.type },
    fields,
    views: viewList,
    childCount,
  };
}
