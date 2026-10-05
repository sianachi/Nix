import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { SHEET_LIMITS } from './limits.js';
import { sheetCellsMap, sheetMetaMap, writeCell } from './model.js';
import { checkSheetDocument, checkSheetSnapshot, sheetSnapshot } from './validate.js';

function sheetDoc(cells: Record<string, string>): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    const map = sheetCellsMap(doc);
    for (const [key, raw] of Object.entries(cells)) {
      map.set(key, { raw });
    }
  });
  return doc;
}

describe('structural validation', () => {
  it('accepts a well-formed sheet', () => {
    expect(checkSheetDocument(sheetDoc({ A1: '1', B2: '=A1*2' }))).toBeNull();
  });

  it('accepts an empty document, which is a new sheet', () => {
    expect(checkSheetDocument(new Y.Doc())).toBeNull();
  });

  it('refuses a key that is not a cell address', () => {
    const verdict = checkSheetDocument(sheetDoc({ 'not-a-cell': '1' }));
    expect(verdict?.code).toBe('sheet_invalid');
  });

  it('refuses a cell outside the address space', () => {
    const verdict = checkSheetDocument(sheetDoc({ A20000: '1' }));
    expect(verdict?.code).toBe('sheet_invalid');
  });

  it('refuses a cell whose value is not { raw: string }', () => {
    const doc = new Y.Doc();
    sheetCellsMap(doc).set('A1', 42);
    expect(checkSheetDocument(doc)?.code).toBe('sheet_invalid');
  });

  it('refuses stored empty text, which must be an absent key', () => {
    const verdict = checkSheetDocument(sheetDoc({ A1: '' }));
    expect(verdict?.code).toBe('sheet_invalid');
  });

  it('refuses raw text over the length bound', () => {
    const verdict = checkSheetDocument(sheetDoc({ A1: 'x'.repeat(SHEET_LIMITS.maxRawLength + 1) }));
    expect(verdict?.code).toBe('sheet_invalid');
  });

  it('refuses more cells than the bound', () => {
    const doc = new Y.Doc();
    const tight = { ...SHEET_LIMITS, maxCells: 3 };
    doc.transact(() => {
      const map = sheetCellsMap(doc);
      map.set('A1', { raw: '1' });
      map.set('A2', { raw: '2' });
      map.set('A3', { raw: '3' });
      map.set('A4', { raw: '4' });
    });
    expect(checkSheetDocument(doc, tight)?.code).toBe('sheet_too_many_cells');
  });

  it('refuses a sheet that cannot evaluate within its op budget', () => {
    const tight = { ...SHEET_LIMITS, maxOps: 10 };
    const verdict = checkSheetDocument(sheetDoc({ A1: '=SUM(B1:B100)' }), tight);
    expect(verdict?.code).toBe('sheet_budget_exceeded');
  });

  it('accepts a sheet whose formulas merely error, because errors are values', () => {
    expect(checkSheetDocument(sheetDoc({ A1: '=1/0', B1: '=A1' }))).toBeNull();
    expect(checkSheetDocument(sheetDoc({ A1: '=A1' }))).toBeNull();
  });
});

describe('snapshots', () => {
  it('validates materialized sheets with the collaboration budgets', () => {
    expect(
      checkSheetSnapshot({
        body: 'sheet',
        cells: { A1: '1', B2: '=A1*2' },
        meta: { rows: 100, cols: 26, colWidths: { A: 240 } },
      }),
    ).toBeNull();
  });

  it('refuses malformed and over-budget materialized sheets', () => {
    expect(
      checkSheetSnapshot({
        body: 'sheet',
        cells: { a1: '1' },
        meta: { rows: 100, cols: 26, colWidths: {} },
      })?.code,
    ).toBe('sheet_invalid');
    expect(
      checkSheetSnapshot(
        {
          body: 'sheet',
          cells: { A1: '=SUM(B1:B100)' },
          meta: { rows: 100, cols: 26, colWidths: {} },
        },
        { ...SHEET_LIMITS, maxOps: 10 },
      )?.code,
    ).toBe('sheet_budget_exceeded');
  });

  it('refuses cells and widths outside the snapshot extents', () => {
    expect(
      checkSheetSnapshot({
        body: 'sheet',
        cells: { B1: 'hidden' },
        meta: { rows: 1, cols: 1, colWidths: {} },
      })?.code,
    ).toBe('sheet_invalid');
    expect(
      checkSheetSnapshot({
        body: 'sheet',
        cells: {},
        meta: { rows: 1, cols: 1, colWidths: { B: 240 } },
      })?.code,
    ).toBe('sheet_invalid');
  });

  it('materializes raw cells as json and evaluated values as tab-separated text', () => {
    const snapshot = sheetSnapshot(sheetDoc({ A1: '2', B1: '=A1*3', A2: 'label' }));
    expect(snapshot.json.body).toBe('sheet');
    expect(snapshot.json.cells).toEqual({ A1: '2', B1: '=A1*3', A2: 'label' });
    expect(snapshot.plaintext).toBe('2\t6\nlabel\t');
  });

  it('renders error values by their code in the plaintext', () => {
    const snapshot = sheetSnapshot(sheetDoc({ A1: '=1/0' }));
    expect(snapshot.plaintext).toBe('#DIV/0!');
  });

  it('falls back to one line per cell when the bounding box is degenerate', () => {
    const snapshot = sheetSnapshot(sheetDoc({ A1: '1', ZZ9999: '2' }));
    expect(snapshot.plaintext).toContain('A1\t1');
    expect(snapshot.plaintext).toContain('ZZ9999\t2');
    expect(snapshot.plaintext.length).toBeLessThan(1000);
  });

  it('snapshots the empty sheet as empty text', () => {
    const snapshot = sheetSnapshot(new Y.Doc());
    expect(snapshot.plaintext).toBe('');
    expect(snapshot.json.cells).toEqual({});
  });

  it('preserves bounded resized column widths in the materialized body', () => {
    const doc = sheetDoc({ A1: 'value' });
    sheetMetaMap(doc).set('colWidths', { A: 240, B: 300 });

    expect(sheetSnapshot(doc).json.meta.colWidths).toEqual({ A: 240, B: 300 });
  });
});

describe('the cell writer', () => {
  it('sets, replaces, and clears while growing the used extents', () => {
    const doc = new Y.Doc();
    writeCell(doc, { row: 199, col: 30 }, '=1+1');
    const map = sheetCellsMap(doc);
    expect(map.get('AE200')).toEqual({ raw: '=1+1' });
    expect(sheetMetaMap(doc).get('rows')).toBe(200);
    expect(sheetMetaMap(doc).get('cols')).toBe(31);
    writeCell(doc, { row: 199, col: 30 }, '');
    expect(map.has('AE200')).toBe(false);
  });
});
