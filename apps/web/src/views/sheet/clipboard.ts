import { type CellRange, cellKey } from '@nix/sheet';

/**
 * Copy and paste as tab-separated raw text.
 *
 * Raw text in both directions on purpose: a formula copied out is a formula
 * pasted back in, so a round trip through the clipboard loses nothing. The
 * cost is that other applications receive `=SUM(A1:A3)` rather than its
 * value, which is also what the incumbents put on the plain-text clipboard.
 *
 * A stated limit: there is no escaping. A value containing a tab or a
 * newline shifts the fields after it, and a paste from a source with quoted
 * multi-line cells lands as extra rows. Accepted for now - the incumbents'
 * plain-text lane has the same failure - but it is a limit, not an oversight.
 */

export function rangeToTsv(cells: ReadonlyMap<string, string>, range: CellRange): string {
  const lines: string[] = [];
  for (let row = range.startRow; row <= range.endRow; row += 1) {
    const fields: string[] = [];
    for (let col = range.startCol; col <= range.endCol; col += 1) {
      fields.push(cells.get(cellKey({ row, col })) ?? '');
    }
    lines.push(fields.join('\t'));
  }
  return lines.join('\n');
}

/** Rows of raw cell texts. A single value is one row of one field. */
export function parseTsv(text: string): string[][] {
  // A trailing newline is a terminator, not an empty row - every spreadsheet
  // and terminal appends one, and pasting it as a row would clear cells the
  // copier never selected.
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return trimmed.split(/\r?\n/).map((line) => line.split('\t'));
}
