import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import {
  SHEET_COLUMN_WIDTH,
  clampColumnWidth,
  readMeta,
  setColumnWidth,
  sheetMetaMap,
} from './model.js';

describe('clampColumnWidth', () => {
  it('leaves a width inside the range alone, rounded to whole pixels', () => {
    expect(clampColumnWidth(200)).toBe(200);
    expect(clampColumnWidth(200.4)).toBe(200);
  });

  it('forces a width below the minimum up to the minimum', () => {
    expect(clampColumnWidth(1)).toBe(SHEET_COLUMN_WIDTH.min);
    expect(clampColumnWidth(-50)).toBe(SHEET_COLUMN_WIDTH.min);
  });

  it('forces a width above the maximum down to the maximum', () => {
    expect(clampColumnWidth(10_000)).toBe(SHEET_COLUMN_WIDTH.max);
  });

  it('turns a width that is not a finite number into the default', () => {
    expect(clampColumnWidth(Number.NaN)).toBe(SHEET_COLUMN_WIDTH.default);
    expect(clampColumnWidth(Number.POSITIVE_INFINITY)).toBe(SHEET_COLUMN_WIDTH.default);
  });
});

describe('setColumnWidth', () => {
  it('stores a width that readMeta returns for that column', () => {
    const doc = new Y.Doc();
    setColumnWidth(doc, 'A', 240);
    expect(readMeta(doc).colWidths).toEqual({ A: 240 });
  });

  it('clamps what it stores, so a drag past the edge cannot persist an out-of-range width', () => {
    const doc = new Y.Doc();
    setColumnWidth(doc, 'B', 4);
    setColumnWidth(doc, 'C', 99_999);
    expect(readMeta(doc).colWidths).toEqual({
      B: SHEET_COLUMN_WIDTH.min,
      C: SHEET_COLUMN_WIDTH.max,
    });
  });

  it('keeps the widths of other columns when one changes', () => {
    const doc = new Y.Doc();
    setColumnWidth(doc, 'A', 200);
    setColumnWidth(doc, 'B', 300);
    setColumnWidth(doc, 'A', 160);
    expect(readMeta(doc).colWidths).toEqual({ A: 160, B: 300 });
  });

  it('writes nothing when the column already has that width', () => {
    const doc = new Y.Doc();
    setColumnWidth(doc, 'A', 200);
    let changed = false;
    sheetMetaMap(doc).observe(() => {
      changed = true;
    });
    setColumnWidth(doc, 'A', 200);
    expect(changed).toBe(false);
  });

  it('heals a hostile stored width when a resize lands on its clamped value', () => {
    // A peer stored 5000; readMeta clamps it to max, so a drag to max would
    // compare equal against the clamped view and write nothing, leaving the
    // hostile value stored forever. The guard compares raw storage instead.
    const doc = new Y.Doc();
    sheetMetaMap(doc).set('colWidths', { A: 5000 });
    setColumnWidth(doc, 'A', SHEET_COLUMN_WIDTH.max);
    expect(sheetMetaMap(doc).get('colWidths')).toEqual({ A: SHEET_COLUMN_WIDTH.max });
  });

  it('is undoable by an undo manager tracking the origin it was transacted under', () => {
    const doc = new Y.Doc();
    const origin = 'local';
    const undo = new Y.UndoManager(sheetMetaMap(doc), { trackedOrigins: new Set([origin]) });
    setColumnWidth(doc, 'A', 200, origin);
    undo.stopCapturing();
    setColumnWidth(doc, 'A', 320, origin);
    undo.undo();
    expect(readMeta(doc).colWidths).toEqual({ A: 200 });
  });
});

describe('readMeta column widths', () => {
  it('ignores stored widths that are not positive finite numbers', () => {
    const doc = new Y.Doc();
    sheetMetaMap(doc).set('colWidths', { A: 'wide', B: -20, C: 0, D: 150 });
    expect(readMeta(doc).colWidths).toEqual({ D: 150 });
  });

  it("clamps a peer's out-of-range stored width into the renderable range", () => {
    const doc = new Y.Doc();
    sheetMetaMap(doc).set('colWidths', { A: 2, B: 50_000 });
    expect(readMeta(doc).colWidths).toEqual({
      A: SHEET_COLUMN_WIDTH.min,
      B: SHEET_COLUMN_WIDTH.max,
    });
  });
});
