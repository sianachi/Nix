import { Node, mergeAttributes } from '@tiptap/core';

/**
 * How many columns one row may hold.
 *
 * Not a schema constraint - the content expression stays permissive, see below - but the
 * ceiling the editor's insert command is to enforce when it is built. Past four, a column on a
 * laptop is narrower than the measure that makes prose readable at all.
 *
 * **Nothing enforces it yet.** There are no column commands in this build; this is the number
 * they will read, exported so there is one of it rather than two.
 */
export const MAX_COLUMNS = 4;

/** A column with no stated width takes an equal share of what is left. */
const EQUAL_SHARE = null;

function readWidth(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return EQUAL_SHARE;
  }
  // A fraction, never a pixel count. Pixels would make a two-column row laid out on a wide
  // screen unreadable on a narrow one, and the widths are normalised against their sum at
  // render, so any positive number is meaningful and no single value can be wrong.
  return value;
}

/**
 * A row of columns: the horizontal axis of a document's composition.
 *
 * **There is no `rowBlock`, and there should never be one.** Blocks stacked vertically are
 * ordinary document flow, which the schema has expressed since the first version. Only
 * side-by-side needed a container, so only side-by-side gets one.
 *
 * **`isolating` and `defining`**, so a selection that starts inside a column does not
 * escape it and a paste into one does not tear the row apart - the same two properties
 * prosemirror-tables gives a cell, for the same reason.
 */
export const ColumnBlock = Node.create({
  name: 'columnBlock',

  group: 'block',

  /**
   * `column+`, not `column column+`.
   *
   * This runs against the strictness of the rest of the set, and the reason is the CRDT.
   * Two people concurrently deleting the second-to-last column produce a merge that is
   * perfectly valid Yjs and, under `column column+`, an invalid document - which the
   * collaboration service refuses with `document_does_not_parse` and a forced resync, for
   * an edit that looked legal to both of them. The schema is permissive at the merge
   * boundary so that merge cannot fail.
   *
   * The same posture `callout.ts` takes on an unknown tone, stated the other way round: a
   * row with one column is readable; a document that will not open is not.
   *
   * **The repair half is not built.** The intent is an `appendTransaction` in the editor that
   * unwraps a one-column row back into flow, where the fix is cheap and nobody loses work.
   * Until the goal that adds column commands lands, a merge that leaves a single column leaves
   * it - readable, editable, and slightly odd. That is the cost of taking the safe side of
   * this trade early, and it is deliberately the smaller wrong.
   */
  content: 'column+',

  isolating: true,

  defining: true,

  parseHTML() {
    return [{ tag: 'div[data-column-block]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-column-block': '' }), 0];
  },
});

/**
 * One column of a row.
 *
 * **In no group, deliberately.** A node in `block` could be inserted at the top level of a
 * document, and a bare column in `doc` is a shape nothing knows how to draw. Being
 * reachable only through `columnBlock`'s content expression is what guarantees it cannot
 * happen, and it is a stronger guarantee than any command-level check.
 *
 * `block*` rather than `block+` for the same merge reason `columnBlock` takes `column+`:
 * two people emptying a column at once must not produce a document that refuses to open. The
 * matching repair - re-filling an empty column with a paragraph so there is somewhere to put
 * the caret - belongs to the same unbuilt `appendTransaction` described above.
 *
 * **Width lives here, per column, and never as an array on the row.** An array is one
 * attribute, so two people dragging two different dividers would both write it and one
 * would lose the other's change wholesale. Per-column attributes bound the loss to the one
 * column that was actually being resized.
 */
export const Column = Node.create({
  name: 'column',

  content: 'block*',

  isolating: true,

  addAttributes() {
    return {
      width: {
        default: EQUAL_SHARE,
        parseHTML: (element) => readWidth(Number(element.getAttribute('data-width'))),
        renderHTML: (attributes) => {
          const width = readWidth(attributes.width);
          return width === EQUAL_SHARE ? {} : { 'data-width': String(width) };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-column]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-column': '' }), 0];
  },
});
