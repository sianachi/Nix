import { type CellRange, type CellRef, cellKey } from '@nix/sheet';

import { TITLE_COLUMN_KEY, resolveConfiguredColumns } from '../core/columns';
import { isComputedType, valueShapeOf } from '../core/property-types';
import {
  readPropertyText,
  type EffectiveSchema,
  type Item,
  type PropertyValue,
  type View,
} from '../core/container-model';
import { dayFor, formatTime, readTimestampValue, readerZone } from '../core/timestamps';

export { TITLE_COLUMN_KEY } from '../core/columns';

/**
 * The spreadsheet view's geometry and coercion, as pure functions.
 *
 * Rows are children and columns are properties, so unlike the spreadsheet body's free grid every
 * cell here has a type - which is why paste and fill go through one coercion table instead of
 * writing raw text. The component owns the DOM and the writes; everything that can be a unit test
 * lives here instead.
 */

export interface SpreadsheetColumn {
  readonly key: string;
  readonly label: string;

  /**
   * The schema's type for this column, or null for the title and for columns the schema does not
   * describe. A null type reads and copies but never edits: there is nothing to coerce a draft
   * into, and writing a guess would corrupt the very value the column exists to show.
   */
  readonly type: string | null;

  readonly editable: boolean;
}

/**
 * The types whose values a person can honestly type into a text overlay.
 *
 * Narrower than `isKnownPropertyType`, deliberately: that predicate means "the property panel has
 * a control for this", and the panel has a zone picker and an image control this grid does not.
 * A `timestamp` is stored as RFC 9557 with a bracketed zone - a format nobody would type and the
 * server refuses anything else - and an `image` is an asset reference free text can only break.
 * Those columns read (and copy their stored value) but never edit; the grid says so when asked.
 */
const TEXT_EDITABLE_TYPES: readonly string[] = [
  'text',
  'number',
  'select',
  'multi_select',
  'date',
  'checkbox',
  'url',
];

/**
 * Types whose *shape* is text but whose values are not something a person should type free-form.
 *
 * `assignee` shares its shape with plain `text` on purpose - see `valueShapeOf` - so width and
 * clearing stay on one switch with everything else string-shaped. But its value is a principal's
 * identifier, a canonical lowercase UUID, and a person typing one into a cell is not a workflow:
 * the picker that turns a name into that identifier lives in the property panel, not here. Named by
 * type rather than by shape, unlike `TEXT_EDITABLE_TYPES` above, because there is nothing left in
 * the shape itself to tell `assignee` apart from an ordinary string.
 */
const TEXT_SHAPED_BUT_NOT_TEXT_EDITABLE: readonly string[] = ['assignee'];

/**
 * The columns, in order: the title first, then the properties.
 *
 * Resolution is the shared rule (`views/core/columns.ts`); what stays here is this view's answer
 * for an unresolvable key: a configured column the schema no longer describes still gets a column
 * headed by its key - a renamed property should leave a column of blanks with a name, not vanish
 * without a stated reason - and it reads without editing.
 */
export function resolveColumns(
  view: View | null,
  schema: EffectiveSchema | null,
): readonly SpreadsheetColumn[] {
  const { keys, definitions } = resolveConfiguredColumns(view, schema);

  return [
    { key: TITLE_COLUMN_KEY, label: 'Title', type: null, editable: false },
    ...keys.map((key): SpreadsheetColumn => {
      const definition = definitions.get(key);
      const type = definition?.type ?? null;

      return {
        key,
        label: definition?.label ?? key,
        type,
        editable:
          type !== null &&
          // Stated rather than left to the shape switch's default. A computed column already came
          // out uneditable, but only because `formula` happens not to be a shape in the list above
          // - an accident that would reverse the day that list grew, and would then send a paste
          // over the column into a per-row refusal from Core.
          !isComputedType(type) &&
          TEXT_EDITABLE_TYPES.includes(valueShapeOf(type)) &&
          !TEXT_SHAPED_BUT_NOT_TEXT_EDITABLE.includes(type),
      };
    }),
  ];
}

/**
 * A column's width, by what its values look like.
 *
 * Fixed rather than resizable: persisting a width would be a new field on the view record -
 * ADR-0020's nine-place threading cost - and a resize that does not persist is a promise the next
 * visit breaks. Until a goal pays for the field, the type is a better guess than a drag nobody
 * can keep.
 */
export function columnWidth(column: SpreadsheetColumn): number {
  if (column.key === TITLE_COLUMN_KEY) {
    return 240;
  }

  switch (valueShapeOf(column.type ?? '')) {
    case 'checkbox':
      return 96;
    case 'number':
      return 128;
    case 'date':
      return 152;
    case 'timestamp':
      return 232;
    default:
      return 184;
  }
}

/** What a copy carries, and what an opened edit starts from: the stored value as text. */
export function cellText(item: Item, column: SpreadsheetColumn): string {
  if (column.key === TITLE_COLUMN_KEY) {
    return item.title;
  }

  return readPropertyText(item, column.key);
}

/**
 * What a cell shows, which is not always what it stores.
 *
 * A timestamp is stored as RFC 9557 with a bracketed zone - `2026-03-17T09:00:00+00:00[Europe/London]` -
 * which printed verbatim is storage syntax in the wrong zone for most readers (ADR-0012's whole
 * point). It is shown as the reader's own clock instead. The copy value stays the stored string
 * (`cellText` above), so a copied timestamp pastes back losslessly. Everything else shows what it
 * stores: an ISO date is unambiguous, and inventing a second spelling would cost the round trip.
 */
export function cellDisplay(item: Item, column: SpreadsheetColumn): string {
  if (column.type === 'timestamp') {
    const stored = readTimestampValue(item.properties, column.key);

    if (stored !== null) {
      const zone = readerZone();
      return `${dayFor(stored, zone)} ${formatTime(stored, zone)}`;
    }
  }

  return cellText(item, column);
}

/** A coerced draft, or the sentence explaining why the text cannot become this column's value. */
export type Coerced =
  | { readonly ok: true; readonly value: PropertyValue }
  | { readonly ok: false; readonly reason: string };

/**
 * Turns the text somebody typed or pasted into the value the column's type stores.
 *
 * Only what has one obvious spelling is decided here - numbers, checkbox words, the comma in a
 * multi-select. Everything else passes through as text for the server to judge, because the server
 * owns validation and a second opinion here could only disagree with it: a select value outside
 * the options or a malformed date comes back as a refusal naming the rule, which is a better
 * answer than this function guessing at one.
 */
export function coerceCellText(text: string, type: string | null): Coerced {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    // Empty clears, per the merge contract - except a checkbox, whose "unchecked" is a value.
    return { ok: true, value: valueShapeOf(type ?? '') === 'checkbox' ? false : null };
  }

  switch (type === null ? null : valueShapeOf(type)) {
    case 'number': {
      const parsed = Number(trimmed);

      if (!Number.isFinite(parsed)) {
        return { ok: false, reason: `"${trimmed}" is not a number.` };
      }

      // The shape says "number"; the TYPE says which numbers are legal. Priority is the one
      // number-shaped type with a closed scale, and committing a 7 here for the server to refuse
      // later is the failure the panel's own select exists to prevent.
      if (type === 'priority' && !(Number.isInteger(parsed) && parsed >= 1 && parsed <= 4)) {
        return { ok: false, reason: `Priority is a whole number from 1 (most urgent) to 4.` };
      }

      return { ok: true, value: parsed };
    }

    case 'checkbox': {
      const word = trimmed.toLowerCase();

      if (word === 'yes' || word === 'true' || word === '1' || word === 'x') {
        return { ok: true, value: true };
      }

      if (word === 'no' || word === 'false' || word === '0') {
        return { ok: true, value: false };
      }

      return { ok: false, reason: `"${trimmed}" is not a yes or a no.` };
    }

    case 'multi_select': {
      const values = trimmed
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

      return { ok: true, value: values.length === 0 ? null : values };
    }

    default:
      return { ok: true, value: trimmed };
  }
}

/** One row's worth of writes: the item, and the property changes going to it together. */
export interface RowWrite {
  readonly item: Item;
  readonly bag: Record<string, PropertyValue>;
}

/**
 * The writes a block of text produces, and the cells it could not take - told apart by why.
 *
 * The two reasons are different sentences. A read-only cell (the title, an uneditable type, a row
 * past the last child) is structural: clearing a whole row will always brush the title, and
 * announcing that as a failure would make the most ordinary gesture in the grid sound broken. An
 * unusable value - text that could not become the column's value - is about what somebody pasted,
 * and is worth a sentence.
 */
export interface WritePlan {
  readonly writes: readonly RowWrite[];

  /** Cells that are never writable by construction. Not spoken of. */
  readonly readOnly: number;

  /** Cells whose text could not become the column's value. Spoken of. */
  readonly unusable: number;
}

/**
 * Where a pasted block of TSV lands: one bag per row, anchored at a cell, clipped to the grid.
 *
 * Clipped rather than growing the container - a paste that silently created items would be a
 * create nobody asked for - and one bag per row rather than one write per cell, so a row pasted
 * across five columns is one request and one optimistic update instead of five racing ones.
 */
export function pastePlan(
  anchor: CellRef,
  block: readonly (readonly string[])[],
  items: readonly Item[],
  columns: readonly SpreadsheetColumn[],
): WritePlan {
  const writes: RowWrite[] = [];
  let readOnly = 0;
  let unusable = 0;

  block.forEach((fields, rowOffset) => {
    const item = items[anchor.row + rowOffset];

    if (item === undefined) {
      readOnly += fields.length;
      return;
    }

    const bag: Record<string, PropertyValue> = {};
    let taken = 0;

    fields.forEach((field, colOffset) => {
      const column = columns[anchor.col + colOffset];

      if (column?.editable !== true) {
        readOnly += 1;
        return;
      }

      const coerced = coerceCellText(field, column.type);

      if (!coerced.ok) {
        unusable += 1;
        return;
      }

      bag[column.key] = coerced.value;
      taken += 1;
    });

    if (taken > 0) {
      writes.push({ item, bag });
    }
  });

  return { writes, readOnly, unusable };
}

/**
 * Fill down: the range's first row, repeated over every row below it.
 *
 * The incumbents' Ctrl+D, and the "fill" the goal names: the top row of the selection is the
 * pattern and the rest of the range receives it. Values are re-coerced from their text on the way
 * so a filled cell is exactly what typing the same text would have stored.
 */
export function fillPlan(
  range: CellRange,
  items: readonly Item[],
  columns: readonly SpreadsheetColumn[],
): WritePlan {
  const source = items[range.startRow];

  if (source === undefined || range.endRow === range.startRow) {
    return { writes: [], readOnly: 0, unusable: 0 };
  }

  const pattern: readonly string[] = columnsIn(range, columns).map((column) =>
    cellText(source, column),
  );

  return pastePlan(
    { row: range.startRow + 1, col: range.startCol },
    Array.from({ length: range.endRow - range.startRow }, () => pattern),
    items,
    columns,
  );
}

/** A cleared range: every editable cell in it, written to nothing, one bag per row. */
export function clearPlan(
  range: CellRange,
  items: readonly Item[],
  columns: readonly SpreadsheetColumn[],
): WritePlan {
  const blank = columnsIn(range, columns).map(() => '');

  return pastePlan(
    { row: range.startRow, col: range.startCol },
    Array.from({ length: range.endRow - range.startRow + 1 }, () => blank),
    items,
    columns,
  );
}

function columnsIn(
  range: CellRange,
  columns: readonly SpreadsheetColumn[],
): readonly SpreadsheetColumn[] {
  return columns.slice(range.startCol, range.endCol + 1);
}

/**
 * The cells of a range as the map `rangeToTsv` reads, built for the range rather than the grid.
 *
 * The body's copy walks a map it already has; this view has items and columns instead, so the map
 * is made to order - the range's size, not the grid's.
 */
export function rangeTextMap(
  range: CellRange,
  items: readonly Item[],
  columns: readonly SpreadsheetColumn[],
): ReadonlyMap<string, string> {
  const cells = new Map<string, string>();

  for (let row = range.startRow; row <= range.endRow; row += 1) {
    const item = items[row];

    if (item === undefined) {
      continue;
    }

    for (let col = range.startCol; col <= range.endCol; col += 1) {
      const column = columns[col];

      if (column !== undefined) {
        cells.set(cellKey({ row, col }), cellText(item, column));
      }
    }
  }

  return cells;
}
