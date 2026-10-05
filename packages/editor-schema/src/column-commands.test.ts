import type { Node as PMNode } from '@tiptap/pm/model';
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state';
import { describe, expect, it } from 'vitest';

import type { ColumnRepairReporter } from './column-commands.js';
import {
  addColumnAfterTr,
  columnGrowFactors,
  columnPairShare,
  columnRepairPlugin,
  insertColumnBlockTr,
  moveBlockToColumnTr,
  removeColumnTr,
  repairColumnsTr,
  resizedColumnWidths,
  setColumnWidthsTr,
} from './column-commands.js';
import { MAX_COLUMNS } from './columns.js';
import { nixSchema, parseDocument } from './schema.js';

/**
 * Columns, at the layer that has no DOM.
 *
 * The commands and the repair are ProseMirror state transforms, so they are asserted here in
 * the same Node process the collaboration service runs in - which is also the only honest place
 * to assert the repair, because the shapes it fixes are the ones a CRDT merge produces and no
 * amount of typing in a browser can.
 */

/**
 * The plugin's options, as the editor supplies them: y-prosemirror's meta by its string, and a
 * reporter that collects rather than warns.
 */
function repairOptions(onUnrepaired: ColumnRepairReporter = () => undefined): {
  isRemote: (transaction: Transaction) => boolean;
  onUnrepaired: ColumnRepairReporter;
} {
  return {
    isRemote: (transaction) => transaction.getMeta('y-sync$') !== undefined,
    onUnrepaired,
  };
}

function paragraph(text?: string): unknown {
  return text === undefined
    ? { type: 'paragraph' }
    : { type: 'paragraph', content: [{ type: 'text', text }] };
}

function column(children: readonly unknown[], width?: number | null): unknown {
  return {
    type: 'column',
    attrs: { width: width ?? null },
    content: children,
  };
}

function stateOf(content: readonly unknown[]): EditorState {
  const parsed = parseDocument({ type: 'doc', content });
  if (!parsed.ok) {
    throw new Error(`The fixture does not parse: ${parsed.error}`);
  }
  return EditorState.create({ schema: nixSchema, doc: parsed.document });
}

/** Puts the caret at the first text position inside the `index`-th text block of the document. */
function withCaretIn(state: EditorState, text: string): EditorState {
  // An array rather than a nullable local: an assignment inside the callback is invisible to
  // the narrowing, so a `=== null` check afterwards reads as always true.
  const found: number[] = [];
  state.doc.descendants((node, pos) => {
    if (found.length === 0 && node.isText && node.text === text) {
      found.push(pos);
    }
    return found.length === 0;
  });
  const at = found[0];
  if (at === undefined) {
    throw new Error(`No text node reads "${text}".`);
  }
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, at)));
}

/** Applies a transform to a state and returns the result, so assertions read as documents. */
function applied(state: EditorState, transform: (tr: Transaction) => boolean): EditorState {
  const tr = state.tr;
  transform(tr);
  return state.apply(tr);
}

function rowOf(state: EditorState): { readonly pos: number; readonly node: PMNode } {
  const found: { pos: number; node: PMNode }[] = [];
  state.doc.descendants((node, pos) => {
    if (found.length === 0 && node.type.name === 'columnBlock') {
      found.push({ pos, node });
    }
    return found.length === 0;
  });
  const row = found[0];
  if (row === undefined) {
    throw new Error('The document holds no row of columns.');
  }
  return row;
}

/** The left column's share of the pair either side of divider `index`, from a width list. */
function pairShareOf(widths: readonly number[], index: number): number {
  const left = widths[index] ?? 0;
  const right = widths[index + 1] ?? 0;
  return left + right === 0 ? 0 : left / (left + right);
}

function columnTexts(state: EditorState): string[][] {
  const row = rowOf(state).node;
  const texts: string[][] = [];
  row.forEach((col) => {
    const inner: string[] = [];
    col.forEach((child) => {
      inner.push(child.textContent);
    });
    texts.push(inner);
  });
  return texts;
}

describe('inserting a row of columns', () => {
  it('creates two columns, each with somewhere to put the caret', () => {
    const state = applied(stateOf([paragraph()]), (tr) => insertColumnBlockTr(tr, 2, true));

    expect(columnTexts(state)).toEqual([[''], ['']]);
  });

  it('puts the caret in the first column, so typing goes where a person is looking', () => {
    const state = applied(stateOf([paragraph()]), (tr) => insertColumnBlockTr(tr, 2, true));
    const row = rowOf(state);

    expect(state.selection.from).toBeGreaterThan(row.pos);
    expect(state.selection.$from.node(state.selection.$from.depth - 1).type.name).toBe('column');
    expect(state.selection.$from.index(state.selection.$from.depth - 2)).toBe(0);
  });

  it('refuses a count below two, because one column is ordinary flow', () => {
    const state = applied(stateOf([paragraph()]), (tr) => insertColumnBlockTr(tr, 1, true));

    expect(rowOf(state).node.childCount).toBe(2);
  });

  it('clamps to the ceiling the schema documents', () => {
    const state = applied(stateOf([paragraph()]), (tr) => insertColumnBlockTr(tr, 9, true));

    expect(rowOf(state).node.childCount).toBe(MAX_COLUMNS);
  });

  it('refuses inside a row, because a nested row is a shape nothing can edit', () => {
    const nested = withCaretIn(
      stateOf([
        { type: 'columnBlock', content: [column([paragraph('a')]), column([paragraph()])] },
      ]),
      'a',
    );

    expect(insertColumnBlockTr(nested.tr, 2, false)).toBe(false);
  });
});

describe('adding a column', () => {
  const row = {
    type: 'columnBlock',
    content: [column([paragraph('left')]), column([paragraph('right')])],
  };

  it('adds the new column after the caret’s', () => {
    const state = applied(withCaretIn(stateOf([row]), 'left'), (tr) => addColumnAfterTr(tr, true));

    expect(columnTexts(state)).toEqual([['left'], [''], ['right']]);
  });

  it('states no width, so it takes an equal share of what is left', () => {
    const state = applied(withCaretIn(stateOf([row]), 'left'), (tr) => addColumnAfterTr(tr, true));

    expect(rowOf(state).node.child(1).attrs.width).toBeNull();
  });

  it('refuses past the ceiling', () => {
    const full = {
      type: 'columnBlock',
      content: [
        column([paragraph('a')]),
        column([paragraph('b')]),
        column([paragraph('c')]),
        column([paragraph('d')]),
      ],
    };

    expect(addColumnAfterTr(withCaretIn(stateOf([full]), 'a').tr, false)).toBe(false);
  });

  it('refuses outside a row', () => {
    expect(addColumnAfterTr(withCaretIn(stateOf([paragraph('loose')]), 'loose').tr, false)).toBe(
      false,
    );
  });
});

describe('removing a column', () => {
  const three = {
    type: 'columnBlock',
    content: [column([paragraph('one')]), column([paragraph('two')]), column([paragraph('three')])],
  };

  it('carries the content into the column before it, so nothing is lost', () => {
    const state = applied(withCaretIn(stateOf([three]), 'two'), (tr) => removeColumnTr(tr, true));

    expect(columnTexts(state)).toEqual([['one', 'two'], ['three']]);
  });

  it('carries the first column’s content into the one after it', () => {
    const state = applied(withCaretIn(stateOf([three]), 'one'), (tr) => removeColumnTr(tr, true));

    expect(columnTexts(state)).toEqual([['one', 'two'], ['three']]);
  });

  it('takes a blank column away without leaving an empty paragraph behind', () => {
    const withBlank = {
      type: 'columnBlock',
      content: [column([paragraph('kept')]), column([paragraph()])],
    };
    const state = applied(withCaretIn(stateOf([withBlank]), 'kept'), (tr) =>
      // The caret is in the first column, so remove that one and check the blank survives alone -
      // which the repair then unwraps. Here only the removal is under test.
      removeColumnTr(tr, true),
    );

    expect(state.doc.textContent).toBe('kept');
  });

  it('unwraps the row back into flow when the last column goes', () => {
    const single = {
      type: 'columnBlock',
      content: [column([paragraph('alone')])],
    };
    const state = applied(withCaretIn(stateOf([single]), 'alone'), (tr) =>
      removeColumnTr(tr, true),
    );

    expect(state.doc.firstChild?.type.name).toBe('paragraph');
    expect(state.doc.textContent).toBe('alone');
  });
});

describe('widths', () => {
  const row = {
    type: 'columnBlock',
    content: [column([paragraph('a')], 3), column([paragraph('b')], 1)],
  };

  it('reads an unstated width as an equal share', () => {
    const plain = stateOf([
      { type: 'columnBlock', content: [column([paragraph('a')]), column([paragraph('b')])] },
    ]);
    expect(columnGrowFactors(rowOf(plain).node)).toEqual([1, 1]);
  });

  it('reports a divider’s share over its own pair, not the whole row', () => {
    expect(columnPairShare(rowOf(stateOf([row])).node, 0)).toBeCloseTo(0.75);
  });

  it('moves only the pair either side of the divider that was dragged', () => {
    const three = rowOf(
      stateOf([
        {
          type: 'columnBlock',
          content: [
            column([paragraph('a')], 1),
            column([paragraph('b')], 1),
            column([paragraph('c')], 4),
          ],
        },
      ]),
    ).node;
    const widths = resizedColumnWidths(three, 0, 0.75) ?? [];

    // The third column keeps its share of the row: 4 of 6 before, and the same fraction after,
    // which is what per-column widths buy over one array on the row.
    const sum = widths.reduce((total, value) => total + value, 0);
    expect((widths[2] ?? 0) / sum).toBeCloseTo(4 / 6);
    expect(pairShareOf(widths, 0)).toBeCloseTo(0.75);
  });

  it('never squeezes a column below the readable minimum', () => {
    const widths = resizedColumnWidths(rowOf(stateOf([row])).node, 0, 0) ?? [];

    expect(pairShareOf(widths, 0)).toBeCloseTo(0.15);
  });

  it('normalises what it writes, so stored numbers stay near one', () => {
    const widths = resizedColumnWidths(rowOf(stateOf([row])).node, 0, 0.5) ?? [];

    expect(widths.reduce((total, value) => total + value, 0)).toBeCloseTo(2);
  });

  it('writes one width per column and refuses a list of the wrong length', () => {
    const state = stateOf([row]);
    const pos = rowOf(state).pos;

    expect(setColumnWidthsTr(state.tr, pos, [1], false)).toBe(false);

    const next = applied(state, (tr) => setColumnWidthsTr(tr, pos, [1.5, 0.5], true));
    expect(rowOf(next).node.child(0).attrs.width).toBe(1.5);
    expect(rowOf(next).node.child(1).attrs.width).toBe(0.5);
  });
});

describe('moving a block between columns', () => {
  const row = {
    type: 'columnBlock',
    content: [column([paragraph('left')]), column([paragraph('right'), paragraph('below')])],
  };

  it('appends to the previous column, so the block keeps reading order', () => {
    const state = applied(withCaretIn(stateOf([row]), 'right'), (tr) =>
      moveBlockToColumnTr(tr, 'previous', true),
    );

    expect(columnTexts(state)).toEqual([['left', 'right'], ['below']]);
  });

  it('prepends to the next column, so it stays next to where it came from', () => {
    const state = applied(withCaretIn(stateOf([row]), 'left'), (tr) =>
      moveBlockToColumnTr(tr, 'next', true),
    );

    // The source column is left empty rather than back-filled here: refilling it is the
    // normaliser's job, and doing it in two places is how the two would come to disagree.
    expect(columnTexts(state)).toEqual([[], ['left', 'right', 'below']]);
  });

  it('carries the caret with the block', () => {
    const state = applied(withCaretIn(stateOf([row]), 'right'), (tr) =>
      moveBlockToColumnTr(tr, 'previous', true),
    );

    expect(state.doc.nodeAt(state.selection.from - 1)?.textContent ?? '').toContain('right');
  });

  it('leaves the emptied column for the normaliser to refill', () => {
    const state = EditorState.create({
      schema: nixSchema,
      doc: stateOf([row]).doc,
      plugins: [columnRepairPlugin(repairOptions())],
    });
    const withCaret = withCaretIn(state, 'left');
    const tr = withCaret.tr;
    moveBlockToColumnTr(tr, 'next', true);

    expect(columnTexts(withCaret.apply(tr))).toEqual([[''], ['left', 'right', 'below']]);
  });

  it('refuses at the ends of the row', () => {
    expect(moveBlockToColumnTr(withCaretIn(stateOf([row]), 'left').tr, 'previous', false)).toBe(
      false,
    );
    expect(moveBlockToColumnTr(withCaretIn(stateOf([row]), 'right').tr, 'next', false)).toBe(false);
  });

  it('refuses outside a row', () => {
    expect(
      moveBlockToColumnTr(withCaretIn(stateOf([paragraph('loose')]), 'loose').tr, 'next', false),
    ).toBe(false);
  });
});

describe('repairing what a merge can leave behind', () => {
  it('unwraps a one-column row back into flow', () => {
    const state = applied(
      stateOf([{ type: 'columnBlock', content: [column([paragraph('survivor')])] }]),
      repairColumnsTr,
    );

    expect(state.doc.firstChild?.type.name).toBe('paragraph');
    expect(state.doc.textContent).toBe('survivor');
  });

  it('keeps the caret where it was when it unwraps the first column', () => {
    const before = withCaretIn(
      stateOf([{ type: 'columnBlock', content: [column([paragraph('survivor')])] }]),
      'survivor',
    );
    const offsetInText = before.selection.from - before.selection.$from.start();

    const after = applied(before, repairColumnsTr);

    expect(after.selection.$from.parent.textContent).toBe('survivor');
    expect(after.selection.from - after.selection.$from.start()).toBe(offsetInText);
  });

  it('refills an emptied column, so there is somewhere to put the caret', () => {
    const state = applied(
      stateOf([{ type: 'columnBlock', content: [column([paragraph('kept')]), column([])] }]),
      repairColumnsTr,
    );

    expect(columnTexts(state)).toEqual([['kept'], ['']]);
  });

  it('replaces a width that is not a positive number with an equal share', () => {
    // A pasted document arrives through `parseHTML`, which guards this; a JSON one does not, so
    // this is where junk is actually caught.
    const doc = nixSchema.nodeFromJSON({
      type: 'doc',
      content: [
        {
          type: 'columnBlock',
          content: [column([paragraph('a')], -4), column([paragraph('b')], 1)],
        },
      ],
    });
    const state = applied(EditorState.create({ schema: nixSchema, doc }), repairColumnsTr);

    expect(rowOf(state).node.child(0).attrs.width).toBeNull();
  });

  it('renormalises widths that have drifted, without changing what a reader sees', () => {
    const state = applied(
      stateOf([
        {
          type: 'columnBlock',
          content: [column([paragraph('a')], 300), column([paragraph('b')], 100)],
        },
      ]),
      repairColumnsTr,
    );
    const node = rowOf(state).node;

    expect(columnGrowFactors(node).reduce((total, value) => total + value, 0)).toBeCloseTo(2);
    expect(columnPairShare(node, 0)).toBeCloseTo(0.75);
  });

  it('leaves a healthy row alone', () => {
    const healthy = stateOf([
      { type: 'columnBlock', content: [column([paragraph('a')]), column([paragraph('b')])] },
    ]);

    expect(repairColumnsTr(healthy.tr)).toBe(false);
  });

  it('leaves a row alone when only some columns state a width', () => {
    // `null` means "an equal share of what is left", so rescaling the stated ones would change
    // what is left - a repair that moved the layout is not a repair.
    const mixed = stateOf([
      { type: 'columnBlock', content: [column([paragraph('a')], 3), column([paragraph('b')])] },
    ]);

    expect(repairColumnsTr(mixed.tr)).toBe(false);
  });

  it('heals a merge on the next local change, and not on the merge itself', () => {
    // The plugin form. A merge is seen by every open client at once, so repairing on receipt
    // would have N clients each append and broadcast the same fix - N paragraphs into one empty
    // column, since an insertion is not idempotent. Gating on a local change makes exactly one
    // client repair: the next one to type.
    const state = EditorState.create({
      schema: nixSchema,
      doc: nixSchema.nodeFromJSON({ type: 'doc', content: [paragraph('before')] }),
      plugins: [columnRepairPlugin(repairOptions())],
    });

    const broken = nixSchema.nodeFromJSON({
      type: 'doc',
      content: [{ type: 'columnBlock', content: [column([paragraph('merged')])] }],
    });
    // Arriving through the CRDT binding, which is what `y-sync$` marks: left as it came.
    const remote = state.tr.replaceWith(0, state.doc.content.size, broken.content);
    remote.setMeta('y-sync$', { isChangeOrigin: true });
    const merged = state.apply(remote);

    expect(merged.doc.firstChild?.type.name).toBe('columnBlock');

    // The next thing this client types is what heals it.
    const healed = merged.apply(merged.tr.insertText('!', merged.doc.content.size - 3));

    expect(healed.doc.firstChild?.type.name).toBe('paragraph');
    expect(healed.doc.textContent).toContain('merged');
  });

  it('scans only what changed, so a keystroke does not walk the document', () => {
    // The guarantee behind that: ProseMirror documents are persistent, so an untouched subtree
    // is the same object before and after an edit. `since` is what lets the scan skip them, and
    // the observable consequence is that a fault in prose the change never touched is not found
    // until a change touches it.
    const content = [
      { type: 'columnBlock', content: [column([paragraph('stale')])] },
      paragraph('elsewhere'),
    ];
    const state = stateOf(content);
    const typed = state.tr.insertText('!', state.doc.content.size - 1);

    expect(repairColumnsTr(typed, state.doc)).toBe(false);

    // The same document, scanned in full, does find it.
    expect(repairColumnsTr(state.tr)).toBe(true);
  });

  it('unwraps a row that has ended up inside a column', () => {
    // No command mints one - the insert refuses inside a row and the drop path refuses the
    // slice - but a paste or a merge can, and it is a shape the product cannot draw or edit.
    const state = applied(
      stateOf([
        {
          type: 'columnBlock',
          content: [
            column([
              paragraph('outer'),
              {
                type: 'columnBlock',
                content: [column([paragraph('inner one')]), column([paragraph('inner two')])],
              },
            ]),
            column([paragraph('beside')]),
          ],
        },
      ]),
      (tr) => repairColumnsTr(tr),
    );

    // The inner row's content is back in the column that held it, and the outer row stands.
    expect(columnTexts(state)).toEqual([['outer', 'inner one', 'inner two'], ['beside']]);
  });

  it('converges on a document with several faults in one call', () => {
    // Each repair rewrites the subtree the next has to look at, so the loop rescans. Nothing
    // pinned the loop itself before this: every other test here has exactly one fault.
    const state = applied(
      stateOf([
        { type: 'columnBlock', content: [column([paragraph('alone')])] },
        paragraph('between'),
        { type: 'columnBlock', content: [column([paragraph('kept')]), column([])] },
      ]),
      (tr) => repairColumnsTr(tr),
    );

    expect(state.doc.child(0).type.name).toBe('paragraph');
    expect(columnTexts(state)).toEqual([['kept'], ['']]);
    expect(repairColumnsTr(state.tr)).toBe(false);
  });

  it('leaves a paragraph behind when it unwraps a row with nothing in it', () => {
    // A document is `block+`, so replacing an empty row with nothing at all would produce the
    // one shape the schema refuses outright - and the caret would have nowhere to stand.
    const state = applied(
      stateOf([{ type: 'columnBlock', content: [column([paragraph()])] }]),
      (tr) => repairColumnsTr(tr),
    );

    expect(state.doc.childCount).toBe(1);
    expect(state.doc.firstChild?.type.name).toBe('paragraph');
    expect(state.doc.firstChild?.content.size).toBe(0);
  });

  it('says so when it gives up, rather than retrying forever in silence', () => {
    // The loop is bounded so a repair that does not converge cannot hang the editor - but a
    // no-op there is a layout somebody is looking at that will never heal, re-attempted on every
    // keystroke. Reaching the bound is reported. Two hundred and one one-column rows is far past
    // anything a person authors, which is the point: getting here at all is a bug.
    const rows: unknown[] = [];
    for (let index = 0; index < 201; index += 1) {
      rows.push({ type: 'columnBlock', content: [column([paragraph(`row ${String(index)}`)])] });
    }

    const reports: { reason: string; fault: string }[] = [];
    const state = stateOf(rows);
    const tr = state.tr;
    const repaired = repairColumnsTr(tr, undefined, (report) => {
      reports.push({ reason: report.reason, fault: report.fault });
    });

    expect(repaired).toBe(true);
    expect(reports).toEqual([{ reason: 'exhausted', fault: 'unwrap' }]);

    // And what it did manage stands: two hundred rows unwrapped, one left for the next pass.
    expect(tr.doc.children.filter((node) => node.type.name === 'columnBlock')).toHaveLength(1);
  });

  it('heals a merge from a keystroke anywhere, not only one inside the broken row', () => {
    // The composition of two correct optimisations, and the reason the plugin tracks whether a
    // remote change has been scanned. The scoped scan compares documents by reference, and a row
    // a merge broke is *identical* in both documents of a later keystroke elsewhere - so a
    // scoped scan walks past it. For `refill` that row is an empty column: nobody can put a
    // caret in it, so "heals when somebody edits that row" means it never heals at all.
    const state = EditorState.create({
      schema: nixSchema,
      doc: nixSchema.nodeFromJSON({ type: 'doc', content: [paragraph('elsewhere')] }),
      plugins: [columnRepairPlugin(repairOptions())],
    });

    const merged = nixSchema.nodeFromJSON({
      type: 'doc',
      content: [
        paragraph('elsewhere'),
        { type: 'columnBlock', content: [column([paragraph('kept')]), column([])] },
      ],
    });
    const remote = state.tr.replaceWith(0, state.doc.content.size, merged.content);
    remote.setMeta('y-sync$', { isChangeOrigin: true });
    const afterMerge = state.apply(remote);

    // The empty column is still there: repairing on receipt would have every open client insert
    // its own paragraph into it.
    expect(afterMerge.doc.child(1).child(1).childCount).toBe(0);

    // A keystroke in the first paragraph - nowhere near the row.
    const healed = afterMerge.apply(afterMerge.tr.insertText('!', 1));

    expect(healed.doc.child(1).child(1).childCount).toBe(1);
    expect(healed.doc.child(1).child(1).firstChild?.type.name).toBe('paragraph');
  });

  it('leaves the document alone when nothing changed', () => {
    const state = EditorState.create({
      schema: nixSchema,
      doc: nixSchema.nodeFromJSON({ type: 'doc', content: [paragraph('quiet')] }),
      plugins: [columnRepairPlugin(repairOptions())],
    });

    const next = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1)));

    expect(next.doc.eq(state.doc)).toBe(true);
  });
});
