import type { Item, PropertyDefinition } from '@nix/api-client';

/** Longest string value a listed row carries; longer ones are cut, never dropped. */
export const LIST_VALUE_CHARS = 200;

/** The largest `nix_list_items` result, as JSON text, that still carries per-row `properties`.
 * Matches the 15,000-character preview `runWorkspaceTool` falls back to for any larger result, so
 * a list either fits whole or arrives without values, never as a cut-off fragment. */
export const LIST_RESULT_CHARS = 15_000;

/** Property types whose values never travel in a list: a long text is a body in all but name. */
const OMITTED_TYPES: ReadonlySet<string> = new Set(['long_text']);

/** The task fields a row surfaces under a fixed name, so the model never has to learn a
 * container's own keys to answer "what is due" or "what is done". Matched by type: each of these
 * types is a reserved, single-key task type in Core. */
const TASK_FIELDS: ReadonlyMap<string, 'dueDate' | 'startDate' | 'completed'> = new Map([
  ['due_date', 'dueDate'],
  ['start_date', 'startDate'],
  ['completion', 'completed'],
]);

export interface ListedRow {
  id: string;
  title: string;
  type: string;
  hasChildren: boolean;
  dueDate?: unknown;
  startDate?: unknown;
  completed?: boolean;
  properties?: Record<string, unknown>;
}

export interface ListedItems {
  items: ListedRow[];
  truncated: boolean;
  propertiesOmitted?: true;
  hint?: string;
}

function cut(text: string): string {
  return text.length <= LIST_VALUE_CHARS ? text : `${text.slice(0, LIST_VALUE_CHARS - 1)}…`;
}

/** One stored value, bounded: strings cut, arrays cut item by item, any other object written as
 * cut JSON text. Undefined for an empty value, which the row then leaves out. */
function trimValue(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value.trim() ? cut(value) : undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const entries = value
      .map((entry) => (typeof entry === 'string' ? cut(entry) : trimValue(entry)))
      .filter((entry) => entry !== undefined);
    return entries.length > 0 ? entries : undefined;
  }
  return cut(JSON.stringify(value));
}

/** One child as a list row: identity, the task fields when its container declares them, and the
 * rest of its values keyed as the container's effective schema keys them. A key the schema does
 * not name (a system `$` key, a value left behind by a removed field) never appears. */
export function listedRow(item: Item, fields: readonly PropertyDefinition[]): ListedRow {
  const row: ListedRow = {
    id: item.id,
    title: item.title,
    type: item.type,
    hasChildren: item.hasChildren,
  };
  const properties: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = item.properties[field.key];
    const taskName = TASK_FIELDS.get(field.type);
    if (taskName === 'completed') {
      row.completed = raw === true;
      continue;
    }
    if (taskName !== undefined) {
      row[taskName] = trimValue(raw) ?? null;
      continue;
    }
    // The title is already the row's own field; a schema that also lists it adds nothing.
    if (OMITTED_TYPES.has(field.type) || field.key === 'title') continue;
    const value = trimValue(raw);
    if (value !== undefined) properties[field.key] = value;
  }
  if (Object.keys(properties).length > 0) row.properties = properties;
  return row;
}

/** The `nix_list_items` result. When the rows with their values would not fit in one tool result,
 * every row's `properties` is dropped (the task fields stay) and the result says so, rather than
 * the whole list arriving cut off mid-row. */
export function listedItems(
  children: readonly Item[],
  fields: readonly PropertyDefinition[],
  truncated: boolean,
): ListedItems {
  const rows = children.map((item) => listedRow(item, fields));
  const whole: ListedItems = { items: rows, truncated };
  if (JSON.stringify(whole).length <= LIST_RESULT_CHARS) return whole;
  return {
    items: rows.map(({ properties, ...rest }) => {
      void properties;
      return rest;
    }),
    truncated,
    propertiesOmitted: true,
    hint: 'Property values were left out to fit. Read one item with nix_read_item for its values.',
  };
}
