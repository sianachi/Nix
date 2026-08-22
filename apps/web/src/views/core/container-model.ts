import { itemSchema, type Item as ApiItem } from '@nix/api-client';
import type {
  ContainerViewsContract,
  EffectiveSchemaContract,
  PropertyDefinitionContract,
  ViewContract,
} from '@nix/api-client';
import { z } from 'zod';

/**
 * What every view renders from: the container's schema, its views, and its children.
 *
 * Parsed at the boundary with Zod, because the API is a runtime boundary like any other and a
 * shape that drifted from the contract should surface here rather than as a blank column three
 * components deep.
 *
 * Parsing alone only catches drift once a response carrying it has already been fetched, so the
 * schemas here additionally carry `satisfies` ties to the generated contract - the same idiom
 * `packages/api-client/src/schemas/item.ts` uses, and for the same reason: a field Core renames
 * should fail a build, not a render.
 *
 * What that idiom does and does not prove is worth stating, because the line reads stronger than it
 * is. It catches a field this schema drops, renames or mistypes, which is the drift that actually
 * happens. It does not catch a field this schema invents: an extra key the contract never carried
 * still satisfies the contract type, and typecheck stays green. So these ties are a floor - the
 * schema is at least as wide as the contract - not a proof that the two agree exactly.
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

  /**
   * For a formula property: the expression evaluated on read, without a leading `=`.
   *
   * Null on every other type, and defaulted rather than merely nullable because a server from
   * before the field answers schemas without it - absence must cost a parse nothing. There is no
   * matching entry in an item's property bag and there never will be: the value is computed where
   * it is drawn, by `properties/computed.ts`, and Core refuses a write that tries to store one.
   */
  expression: z.string().nullable().default(null),

  /**
   * For a rollup property: how the children are folded, and which of their properties.
   *
   * `aggregate` is an open string, matching `mode` and the filter operators and for the same
   * reason: the server polices the closed set on write, and a fold a newer server admits must cost
   * an older build the property rather than the parse of the whole schema. `source` is null for a
   * count of the children themselves, which is the one fold that needs no property.
   *
   * Unlike a formula, a rollup's value arrives *from the server* in `Item.computed` - it is an
   * aggregate over rows the client does not hold. See ADR-0044 for why the two computed types are
   * computed in different places.
   */
  aggregate: z.string().nullable().default(null),
  source: z.string().nullable().default(null),
});

type ParsedPropertyDefinition = z.infer<typeof PropertyDefinitionSchema>;

/**
 * A property definition as this build holds one.
 *
 * The computed fields are optional here and always present after a parse, exactly as `View` treats
 * the fields added to it since it was cut, and for the same reason: a draft being built in a schema
 * editor, a wizard recipe or a test fixture is not a server response and must not have to
 * manufacture wire fields it has no opinion about. Absent and null mean the same thing for each of
 * them.
 */
export type PropertyDefinition = Omit<
  ParsedPropertyDefinition,
  'expression' | 'aggregate' | 'source'
> &
  Partial<Pick<ParsedPropertyDefinition, 'expression' | 'aggregate' | 'source'>>;

const _propertyDefinitionContract =
  PropertyDefinitionSchema satisfies z.ZodType<PropertyDefinitionContract>;
void _propertyDefinitionContract;

export const EffectiveSchemaSchema = z.object({
  properties: z.array(PropertyDefinitionSchema),
  declared: z.array(PropertyDefinitionSchema),
  inherit: z.boolean(),
});

type ParsedEffectiveSchema = z.infer<typeof EffectiveSchemaSchema>;

/**
 * The schema in force, holding definitions in the shape a draft can also be built in.
 *
 * The same relaxation `ContainerViews` makes over `View`, for the same reason: an effective schema
 * assembled by a wizard recipe or a test fixture is not a parse of a server response, and requiring
 * it to carry every wire field would make building one an exercise in filling in nulls.
 */
export type EffectiveSchema = Omit<ParsedEffectiveSchema, 'properties' | 'declared'> & {
  readonly properties: PropertyDefinition[];
  readonly declared: PropertyDefinition[];
};

const _effectiveSchemaContract = EffectiveSchemaSchema satisfies z.ZodType<EffectiveSchemaContract>;
void _effectiveSchemaContract;

export const FormConditionSchema = z.object({
  fieldBlockId: z.string(),
  operator: z.string(),
  value: z.string().nullable(),
});

export const FormBlockSchema = z.object({
  id: z.string(),
  kind: z.string(),
  propertyKey: z.string().nullable(),
  text: z.string(),
  help: z.string().nullable(),
  required: z.boolean(),
  identityRole: z.string().nullable(),
  visibleWhen: z.array(FormConditionSchema),
});

export const FormPageSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  visibleWhen: z.array(FormConditionSchema),
  blocks: z.array(FormBlockSchema),
});

export const InteractiveFormSchema = z.object({
  pages: z.array(FormPageSchema),
  titleMode: z.string(),
  titleFieldBlockId: z.string().nullable(),
  confirmationTitle: z.string(),
  confirmationMessage: z.string(),
});

export type FormCondition = z.infer<typeof FormConditionSchema>;
export type FormBlock = z.infer<typeof FormBlockSchema>;
export type InteractiveFormDefinition = z.infer<typeof InteractiveFormSchema>;

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

  /**
   * For a gallery: how large each card is drawn - `small`, `medium` or `large`.
   *
   * Null means `medium`, which is what every gallery stored before the field existed has always
   * looked like. A plain string rather than an enum, matching `mode` and for the same reason: the
   * server polices the set on write, and a value a newer server admits must cost an older build the
   * size - the gallery falls back to medium - never the parse of the whole view set.
   */
  cardSize: z.string().nullable(),

  /**
   * For a query: the conditions the server compiles and runs, AND-combined.
   *
   * The operator is an open string, matching `mode` and for the same reason: the server polices
   * the closed set on write and re-validates at execution, and an editor meeting a token from a
   * newer build must preserve it rather than fail the parse - only the server executes. Empty is
   * the ordinary state on every other kind, and on a query view it means "everything readable,
   * newest first".
   */
  filters: z
    .array(
      z.object({
        property: z.string(),
        operator: z.string(),
        value: z.string(),
      }),
    )
    // Defaulted, unlike its siblings: a server from before the field answers views without it,
    // and absence must cost nothing - the parse fills the empty set the contract now always sends.
    .default([]),
  companionViewId: z.string().nullable().default(null),
  companionPlacement: z.enum(['below', 'beside']).nullable().default(null),
  interactiveForm: InteractiveFormSchema.nullable().default(null),
});

type ParsedView = z.infer<typeof ViewSchema>;

/** New layout/form fields are optional in drafts; parsed server views always receive null defaults. */
export type View = Omit<ParsedView, 'companionViewId' | 'companionPlacement' | 'interactiveForm'> &
  Partial<Pick<ParsedView, 'companionViewId' | 'companionPlacement' | 'interactiveForm'>>;

/** One condition of a query view. */
export type ViewFilterRule = View['filters'][number];

/**
 * The compile-time tie to the generated contract.
 *
 * `ViewResponse` is the read shape - what `GET /items/{id}/views` returns and what this schema
 * parses. The write shape is `ViewRequest`, which is deliberately wider (its `columns` and
 * `groupOrder` are nullable, meaning "leave these alone"), so tying to it instead would let a read
 * of `columns: null` through and leave a table with nothing to draw.
 *
 * If Core renames a field or changes a type, this line stops compiling here rather than surfacing
 * as an empty column in front of somebody.
 */
const _viewContract = ViewSchema satisfies z.ZodType<ViewContract>;
void _viewContract;

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

type ParsedContainerViews = z.infer<typeof ContainerViewsSchema>;
export type ContainerViews = Omit<ParsedContainerViews, 'views'> & { readonly views: View[] };

const _containerViewsContract = ContainerViewsSchema satisfies z.ZodType<ContainerViewsContract>;
void _containerViewsContract;

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

/**
 * The item shape every view reads through.
 *
 * Re-exported from `@nix/api-client` rather than re-declared here: this file used to carry its own
 * hand-rolled copy of the item schema, and it had drifted from the contract in two ways - it was
 * missing `hasChildren`, and it typed `seq` as `z.number()` where the contract says `number |
 * string`, because `seq` is a 64-bit sibling position that cannot survive a round trip through a
 * JavaScript number once it exceeds `Number.MAX_SAFE_INTEGER`. A silently rounded sort order is the
 * kind of bug that only shows up once a workspace is old enough for it to matter. `itemSchema`
 * already carries the `satisfies` tie to the generated contract, so re-using it here means this file
 * cannot drift from it again.
 */
export { itemSchema as ItemSchema };

/**
 * An item as this build holds one.
 *
 * `computed` is optional here and always present after a parse - the same relaxation
 * `PropertyDefinition` and `ContainerViews` make, for the same reason: a fixture or a
 * locally-constructed row is not a server response, and requiring it to carry a field it has no
 * opinion about would make building one an exercise in filling in nulls. Absent and null both mean
 * "this did not come with folded children".
 */
export type Item = Omit<ApiItem, 'computed'> & Partial<Pick<ApiItem, 'computed'>>;

/**
 * The part of an item a property control actually touches: its name, and its bag.
 *
 * `Item` means "an item as the server sent it, after parse" - a provenance a draft being typed
 * into a form does not have and must not fake. The readers below and `PropertyInput` take this
 * shape instead, so a caller with a real item passes it unchanged (an `Item` is structurally one
 * of these) and a caller with a draft passes `{ title, properties }` without manufacturing wire
 * fields nothing reads.
 */
export interface PropertyOwner {
  readonly title: string;
  readonly properties: Readonly<Record<string, unknown>>;

  /**
   * The rollups the server folded for this item, when the read that produced it folded any.
   *
   * Optional because a draft has none and never will: a rollup is an aggregate over children a
   * draft does not have. Null and absent mean the same thing - "this did not come with folded
   * children" - which is deliberately not the same as an empty object, which means "folded, and
   * there were no rollups declared".
   */
  readonly computed?: Readonly<Record<string, unknown>> | null;
}

/**
 * Reads one property value off an item, as text.
 *
 * Every view needs this and none of them should each decide what a number or a list looks like.
 * Returns an empty string for absent, which is what an empty cell renders as - the distinction
 * between "no value" and "the empty string" is not one a table cell can draw, and pretending
 * otherwise would put "null" in front of people.
 */
export function readPropertyText(item: PropertyOwner, key: string): string {
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
export function readSelectValue(item: PropertyOwner, key: string): string | null {
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
export function readDateValue(item: PropertyOwner, key: string): string | null {
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
 * Compares two sibling positions.
 *
 * `seq` is a 64-bit integer that the contract types as `number | string`: Core sends it as a plain
 * number while it fits in a JavaScript-safe integer and switches to a string once it would not, so
 * ordinary subtraction is wrong the moment a workspace has been reordered enough for that to happen
 * - `Number(seq) - Number(seq)` would silently round both operands to the same value. Comparing as
 * `bigint` is exact at any magnitude either representation can carry.
 */
function compareSeq(left: Item['seq'], right: Item['seq']): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * One collator, hoisted, rather than an options object passed to `localeCompare` per comparison.
 *
 * Passing options to `localeCompare` resolves a collator on every call - roughly n log n of them
 * per sort. Measured at 3,000 items sorted by a text property: 61.65ms per sort the old way,
 * 2.65ms with the collator hoisted, byte-identical ordering (perf review of goal 1.6, harness in
 * its report). A sort runs on every write once a header is clicked, so this is a hot path, not a
 * micro-optimisation.
 */
const textCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

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
    sorted.sort((left, right) => compareSeq(left.seq, right.seq));
    return sorted;
  }

  sorted.sort((left, right) => {
    const a = sortBy === 'title' ? left.title : readPropertyText(left, sortBy);
    const b = sortBy === 'title' ? right.title : readPropertyText(right, sortBy);

    // Empty values sort last in both directions. A column of blanks at the top tells nobody
    // anything, and flipping the direction should not make the blanks the headline.
    if (a === '' && b !== '') return 1;
    if (b === '' && a !== '') return -1;

    const comparison = textCollator.compare(a, b);
    return descending ? -comparison : comparison;
  });

  return sorted;
}
