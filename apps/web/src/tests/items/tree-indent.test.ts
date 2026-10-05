import { describe, expect, it } from 'vitest';

import { CHILD_NOTICE_INDENT, ROW_INDENT, indentAt } from '../../items/workspace-sidebar';

/**
 * The tree's indentation, as the relationship between its two ladders.
 *
 * The sidebar draws depth with a bounded table of `pl-*` classes rather than a computed
 * `paddingLeft`, because inline styles are banned and a custom property set through `style` is
 * still one. That leaves two facts that are true by arithmetic and enforced by nothing: a notice
 * standing in for children has to sit where those children's titles will, and the two ladders have
 * to stop growing at the same depth.
 *
 * Both are easy to break while doing something reasonable. Widening the sidebar means appending a
 * step to `ROW_INDENT`, and the obvious reading of the docblock beside it - "the notice ladder is
 * deliberately shorter" - is exactly the wrong thing to do at that moment. The bug it produces is
 * quiet: "Loading…" sits a step too far in and then jumps left as the children arrive, which looks
 * like a rendering glitch rather than a table that is one entry too long.
 */

/** Spacing steps, parsed back out of the class names the sidebar actually ships. */
function steps(className: string): number {
  const parsed = Number(className.replace('pl-', ''));
  expect(Number.isFinite(parsed)).toBe(true);
  return parsed;
}

/** The chevron and the gap beside it, which a notice clears to reach the title column. */
const GUTTER_STEPS = 6;

describe('the workspace tree indentation', () => {
  it('indents a notice to where the titles of the children it stands in for will start', () => {
    // CHILD_NOTICE_INDENT[i] stands for children at depth i + 1, so it is that row's own indent
    // plus the gutter their chevrons occupy. Checked across every pair that is not clamped.
    for (const [index, notice] of CHILD_NOTICE_INDENT.entries()) {
      expect(steps(notice)).toBeCloseTo(steps(ROW_INDENT[index + 1] ?? '') + GUTTER_STEPS, 10);
    }
  });

  it('stops the notice ladder one level before the row ladder, so a placeholder does not jump', () => {
    // One shorter, exactly. A ninth entry would place a notice under a depth-8 node further in
    // than the children that replace it, and it would visibly slide left as they loaded.
    expect(CHILD_NOTICE_INDENT).toHaveLength(ROW_INDENT.length - 1);
  });

  it('keeps the two ladders agreeing past the depth it stops indenting at', () => {
    // The clamp is the whole reason the lengths differ, so it is the case worth stating: however
    // deep the tree goes, a notice still lands a gutter to the right of its children's rows.
    for (const depth of [8, 9, 20, 500]) {
      const childRow = indentAt(ROW_INDENT, depth + 1);
      const notice = indentAt(CHILD_NOTICE_INDENT, depth);

      expect(steps(notice)).toBeCloseTo(steps(childRow) + GUTTER_STEPS, 10);
    }
  });

  it('never indents past the last step the sidebar has room to draw', () => {
    const deepest = ROW_INDENT[ROW_INDENT.length - 1];

    expect(indentAt(ROW_INDENT, ROW_INDENT.length)).toBe(deepest);
    expect(indentAt(ROW_INDENT, 1000)).toBe(deepest);
    // Depth is never negative in practice; the clamp says so rather than relying on it.
    expect(indentAt(ROW_INDENT, -1)).toBe(ROW_INDENT[0]);
  });
});
