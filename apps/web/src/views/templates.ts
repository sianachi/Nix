import type { ContainerData, SchemaDraft } from './use-container';
import type { PropertyDefinition, View } from './container-model';

/**
 * Ready-made setups, applied to the item you are looking at.
 *
 * Setting up a Kanban by hand is four decisions before any value: declare a select property, add a
 * board view, choose what it groups by, make it the one that opens. Every one of them is obvious
 * only once you have done it. A template does all four.
 *
 * **They are shipped presets, not something a person can save.** One entry per template, and adding
 * one is one entry - the same shape as `view-kinds.tsx`. A user-creatable version needs somewhere to
 * store them, a contract, and an answer to what happens when a template changes after it has been
 * applied; none of which is needed for the thing people actually want, which is to get started.
 *
 * **Schema first, then views.** The server deliberately does not check that a view's property
 * exists, so views-first stores a board that reports itself unrenderable until the schema lands - a
 * broken intermediate state for no gain.
 *
 * **Merged, never replacing.** `setSchema` and `setViews` both replace wholesale, so a template
 * applied to an item that already declares something would silently delete it. Folded into
 * `schema.declared` rather than `schema.properties`, because the latter includes what the item
 * inherits and writing that back turns inheritance into a copy.
 */

export interface Template {
  /** The name a person picks. */
  readonly id: string;

  readonly label: string;

  /** One line saying what applying it will do, in terms of what appears afterwards. */
  readonly detail: string;

  /** The properties it declares. Merged with whatever the item already declares. */
  readonly properties: readonly PropertyDefinition[];

  /** The views it offers. Merged with whatever the item already offers. */
  readonly views: readonly View[];

  /** Which view should open afterwards, or null to leave the item on its document. */
  readonly opensOn: string | null;
}

function view(overrides: Partial<View> & { id: string; name: string; kind: string }): View {
  return {
    columns: [],
    groupBy: null,
    groupOrder: [],
    dateProperty: null,
    sortBy: null,
    sortDescending: false,
    mode: null,
    coverProperty: null,
    endDateProperty: null,
    ...overrides,
  };
}

export const TEMPLATES: readonly Template[] = [
  {
    id: 'kanban',
    label: 'Kanban board',
    detail: 'A Status field, and a board with a column for each of its values.',
    properties: [
      {
        key: 'status',
        label: 'Status',
        type: 'select',
        // At least one option, or the server refuses the schema - a select with nothing to choose
        // from is a column-less board.
        options: ['To do', 'Doing', 'Done'],
        required: false,
      },
    ],
    views: [view({ id: 'board', name: 'Board', kind: 'board', groupBy: 'status' })],
    opensOn: 'board',
  },
  {
    id: 'calendar',
    label: 'Calendar',
    detail: 'A Starts field with a time, and a week view to place things on.',
    properties: [
      { key: 'starts', label: 'Starts', type: 'timestamp', options: [], required: false },
    ],
    views: [
      view({
        id: 'schedule',
        name: 'Schedule',
        kind: 'calendar',
        dateProperty: 'starts',
        mode: 'week',
      }),
    ],
    opensOn: 'schedule',
  },
  {
    id: 'list',
    label: 'Checklist',
    detail: 'A Done tick and an Owner, shown as a list.',
    properties: [
      { key: 'done', label: 'Done', type: 'checkbox', options: [], required: false },
      { key: 'owner', label: 'Owner', type: 'text', options: [], required: false },
    ],
    views: [view({ id: 'all', name: 'All', kind: 'list', columns: ['title', 'done', 'owner'] })],
    opensOn: 'all',
  },
];

export function findTemplate(id: string): Template | null {
  return TEMPLATES.find((template) => template.id === id) ?? null;
}

/**
 * Applies a template to a container.
 *
 * Returns the reason it was refused, or null when it was applied.
 *
 * Idempotent by key and by id: applying the same template twice leaves the item as it was rather
 * than declaring "Status" twice or offering two boards. What is already there wins, so a template
 * never overwrites an option list somebody has edited.
 */
export async function applyTemplate(
  template: Template,
  container: ContainerData,
): Promise<string | null> {
  const declared = container.schema?.declared ?? [];
  const offered = container.views?.views ?? [];

  const properties: PropertyDefinition[] = [
    ...declared,
    ...template.properties.filter((wanted) => !declared.some((own) => own.key === wanted.key)),
  ];

  const draft: SchemaDraft = { properties, inherit: container.schema?.inherit ?? true };

  const schemaRefusal = await container.setSchema(draft);
  if (schemaRefusal !== null) {
    return schemaRefusal;
  }

  const views: View[] = [
    ...offered,
    ...template.views.filter((wanted) => !offered.some((own) => own.id === wanted.id)),
  ];

  // The default is passed explicitly. Omitted, the item still opens on its document - so a
  // one-click "set up a board" would look like it had done nothing at all.
  return await container.setViews(views, template.opensOn);
}
