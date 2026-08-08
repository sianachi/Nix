import { describe, expect, it } from 'vitest';

import { dropZoneAt } from '../../items/workspace-sidebar';

/**
 * Where on a row a drop lands.
 *
 * This distinction used to come free from the item's type - onto a folder meant inside it, onto a
 * note meant beside it. With one kind of item there is nothing left to read it from but where the
 * pointer is, so the arithmetic below is now the whole of the answer and worth pinning down.
 */

describe('the drop zone on a row', () => {
  const height = 32;

  it('puts the top edge before the row', () => {
    expect(dropZoneAt(0, height)).toBe('before');
    expect(dropZoneAt(4, height)).toBe('before');
  });

  it('puts the bottom edge after it', () => {
    expect(dropZoneAt(height, height)).toBe('after');
    expect(dropZoneAt(height - 4, height)).toBe('after');
  });

  it('puts the middle inside it', () => {
    expect(dropZoneAt(height / 2, height)).toBe('inside');
  });

  it('gives the middle the larger share', () => {
    // Dropping something *into* the thing under the pointer is the common intent and should be the
    // easy target; reordering is deliberate. A miss should land you inside rather than somewhere
    // surprising, so the edges are a quarter each and the middle is half.
    const zones = Array.from({ length: height + 1 }, (_, offset) => dropZoneAt(offset, height));
    const inside = zones.filter((zone) => zone === 'inside').length;

    expect(inside).toBeGreaterThan(zones.length / 2);
  });

  it('answers inside when the row has no height to divide', () => {
    // A row measured mid-layout reports zero. Dividing by it would be NaN, and NaN comparisons are
    // all false, so the position would silently read as "after" - a reorder nobody asked for.
    expect(dropZoneAt(0, 0)).toBe('inside');
  });

  it('never leaves a position without an answer', () => {
    for (let offset = -10; offset <= height + 10; offset += 1) {
      expect(['before', 'inside', 'after']).toContain(dropZoneAt(offset, height));
    }
  });
});
