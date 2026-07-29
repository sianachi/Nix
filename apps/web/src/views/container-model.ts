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

  /**
   * The per-kind grain: a calendar's `month`, `week` or `day`; a timeline's `week`, `month` or
   * `quarter`.
   *
   * Nullable rather than optional, and unrecognised values fall back to each kind's own default,
   * because a view written by a newer build must not leave an older one with nothing to draw. The
   * two vocabularies overlapping is deliberate - it is what lets a view switched between the two
   * kinds keep the grain it had rather than being reset to a default nobody chose.
   */
  mode: z.string().nullable(),

  /**
   * For a gallery: the image property each card shows as its cover.
   *
   * Null is the ordinary state and not a broken one - a gallery with no cover property is a grid of
   * titled cards. So nothing downstream may treat this as a precondition for drawing the view; the
   * cards are the view, and the cover is what a card may additionally show.
   */
  coverProperty: z.string().nullable(),

  /**
   * For a timeline: the date each bar ends on.
   *
   * The start is `dateProperty` - the calendar's field, under the calendar's name - and that is
   * what makes switching a view between the two kinds lossless in both directions. Renaming it to
   * something a timeline would prefer would break every calendar already stored.
   *
   * Null is an ordinary state rather than a broken one: an item with a start and no end is a
   * milestone, and a timeline of milestones is a perfectly good timeline. So nothing may treat this
   * as a precondition for drawing the view.
   */
  endDateProperty: z.string().nullable(),
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

  /**
   * Which view opens: a view's id, or `document` for the item's own body.
   *
   * Already resolved by the server, so a default naming a view somebody has since deleted arrives
   * as `document`. Nothing here has to check that the id it was handed still exists.
   */
  default: z.string(),
});

/** What the `default` field says when the item opens on its own body rather than on a view. */
export const DOCUMENT_VIEW = 'document';

export type ContainerViews = z.infer<typeof ContainerViewsSchema>;

/** A property value as it arrives: anything JSON can carry. */
export type PropertyValue = string | number | boolean | readonly string[] | null;

/**
 * How a control says "no value" - the option, and what it is called.
 *
 * The empty string rather than an invented token: `readSelectValue` already treats an empty string
 * as no value, so no declared option can collide with it and there is no `__none__` for somebody to
 * declare by accident. Here rather than in each control because the board's unset column, the
 * property panel's unset option and the list's unset cell are the same absence, and two spellings
 * of it would be two absences somebody has to learn are one.
 */
export const UNSET_VALUE = '';

/** What the absence of a value is called, wherever it is offered. */
export const UNSET_LABEL = 'Unset';

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
