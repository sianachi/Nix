import { z } from 'zod';

/**
 * What every view renders from: the container's schema, its views, and its children.
 *
 * Parsed at the boundary with Zod, because the API is a runtime boundary like any other and a
 * shape that drifted from the contract should surface here rather than as a blank column three
 * components deep.
 */

export const PropertyDefinitionSchema = z.object({
  key: z.string(),
  label: z.string(),

  // An open string rather than an enum, matching the contract: adding a property type should be a
  // feature, not a parse failure in every client that has not been rebuilt. A type this build does
  // not know renders as its raw value.
  type: z.string(),
  options: z.array(z.string()),
  required: z.boolean(),
});

export type PropertyDefinition = z.infer<typeof PropertyDefinitionSchema>;

export const EffectiveSchemaSchema = z.object({
  properties: z.array(PropertyDefinitionSchema),
  declared: z.array(PropertyDefinitionSchema),
  inherit: z.boolean(),
});

export type EffectiveSchema = z.infer<typeof EffectiveSchemaSchema>;

export const ViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  columns: z.array(z.string()),
  groupBy: z.string().nullable(),
  groupOrder: z.array(z.string()),
  dateProperty: z.string().nullable(),
  sortBy: z.string().nullable(),
  sortDescending: z.boolean(),
});

export type View = z.infer<typeof ViewSchema>;

export const ContainerViewsSchema = z.object({
  views: z.array(ViewSchema),

  /**
   * Views whose configured property no longer exists or no longer fits.
   *
   * The honest-state field: without it a board grouping by a deleted property renders empty, which
   * is indistinguishable from an empty folder.
   */
  unrenderable: z.array(z.string()),
});

export type ContainerViews = z.infer<typeof ContainerViewsSchema>;

/** A property value as it arrives: anything JSON can carry. */
export type PropertyValue = string | number | boolean | readonly string[] | null;

export const ItemSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  parentId: z.string().nullable(),
  type: z.string(),
  title: z.string(),
  seq: z.number(),
  lifecycleState: z.string(),
  properties: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Item = z.infer<typeof ItemSchema>;

/** The three kinds a view may be. Anything else is a view this build cannot render. */
export const KNOWN_VIEW_KINDS = ['list', 'board', 'calendar'] as const;

export type KnownViewKind = (typeof KNOWN_VIEW_KINDS)[number];

export function isKnownViewKind(kind: string): kind is KnownViewKind {
  return (KNOWN_VIEW_KINDS as readonly string[]).includes(kind);
}

/**
 * Reads one property value off an item, as text.
 *
 * Every view needs this and none of them should each decide what a number or a list looks like.
 * Returns an empty string for absent, which is what an empty cell renders as - the distinction
 * between "no value" and "the empty string" is not one a table cell can draw, and pretending
 * otherwise would put "null" in front of people.
 */
export function readPropertyText(item: Item, key: string): string {
  const value = item.properties[key];

  if (value === null || value === undefined) {
    return '';
  }

  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string').join(', ');
  }

  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }

  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

/** Reads a property as a single select value, or null when it is not one. */
export function readSelectValue(item: Item, key: string): string | null {
  const value = item.properties[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Reads a property as a calendar date.
 *
 * Dates are stored as `yyyy-MM-dd` with no time and no zone, deliberately: a property that means
 * "the 3rd" must not shift to the 2nd for a reader in another zone, which is exactly what an
 * instant would do. So this compares text and never constructs a Date for placement.
 */
export function readDateValue(item: Item, key: string): string | null {
  const value = item.properties[key];
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

/**
 * Applies the URL's filters to a set of items.
 *
 * **Filtering here rather than on the server is a deliberate limit of this phase, and it is
 * bounded.** A container's children arrive as one page; filtering that page client-side is honest
 * as long as the interface does not claim to have filtered anything it has not loaded. When
 * indexed, permission-filtered querying lands, this function is what it replaces - the call sites
 * and the URL shape do not change.
 */
export function applyFilters(
  items: readonly Item[],
  filters: readonly { propertyKey: string; values: readonly string[] }[],
): readonly Item[] {
  if (filters.length === 0) {
    return items;
  }

  return items.filter((item) =>
    filters.every((filter) => {
      if (filter.values.length === 0) {
        return true;
      }

      const value = item.properties[filter.propertyKey];

      if (Array.isArray(value)) {
        return value.some((entry) => typeof entry === 'string' && filter.values.includes(entry));
      }

      return typeof value === 'string' && filter.values.includes(value);
    }),
  );
}

/**
 * Sorts items by a property, or by sibling order when no property is named.
 *
 * Sibling order is the default because it is the order somebody arranged by hand, and replacing
 * that with an arbitrary alphabetisation is the sort of helpfulness people undo.
 */
export function sortItems(
  items: readonly Item[],
  sortBy: string | null,
  descending: boolean,
): readonly Item[] {
  const sorted = [...items];

  if (sortBy === null) {
    sorted.sort((left, right) => left.seq - right.seq);
    return sorted;
  }

  sorted.sort((left, right) => {
    const a = sortBy === 'title' ? left.title : readPropertyText(left, sortBy);
    const b = sortBy === 'title' ? right.title : readPropertyText(right, sortBy);

    // Empty values sort last in both directions. A column of blanks at the top tells nobody
    // anything, and flipping the direction should not make the blanks the headline.
    if (a === '' && b !== '') return 1;
    if (b === '' && a !== '') return -1;

    const comparison = a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    return descending ? -comparison : comparison;
  });

  return sorted;
}
