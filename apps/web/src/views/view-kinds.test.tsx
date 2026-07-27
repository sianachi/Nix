import { describe, expect, it } from 'vitest';

import { VIEW_KINDS, findViewKind, isKnownViewKind } from './view-kinds';

/**
 * The registry that makes adding a view kind one entry.
 *
 * These tests are about the *table*, not about any one kind. What they protect is the property the
 * table exists for: that a kind declared here is complete everywhere the application needs it, and
 * that a kind not declared here is refused rather than approximated.
 */

describe('the view-kind registry', () => {
  it('knows the three this build can draw', () => {
    expect(isKnownViewKind('list')).toBe(true);
    expect(isKnownViewKind('board')).toBe(true);
    expect(isKnownViewKind('calendar')).toBe(true);
  });

  it('does not claim to know a kind from a newer build', () => {
    // The item screen explains such a view rather than drawing an empty one, which is only possible
    // because this returns false rather than guessing. The dispatch it replaced had a `default`
    // arm, so an unknown kind was silently drawn as a list.
    expect(isKnownViewKind('canvas')).toBe(false);
    expect(findViewKind('canvas')).toBeNull();
  });

  it('gives every kind everything a caller needs', () => {
    // The point of one entry per kind is that the entry is complete. A descriptor missing its icon
    // or its renderer would fail at the point of use - in a switcher tab, or mid-render - rather
    // than here.
    for (const descriptor of VIEW_KINDS) {
      expect(descriptor.kind.length).toBeGreaterThan(0);
      expect(descriptor.label.length).toBeGreaterThan(0);
      expect(descriptor.icon).toBeDefined();
      expect(typeof descriptor.render).toBe('function');
    }
  });

  it('gives no two kinds the same stored name', () => {
    // Two entries sharing a name would make the lookup return whichever came first, so one kind
    // would quietly render as the other.
    const names = VIEW_KINDS.map((descriptor) => descriptor.kind);

    expect(new Set(names).size).toBe(names.length);
  });

  it('describes what each configurable kind needs, and what needs nothing', () => {
    // A list has no requirement: with no columns configured it falls back to the effective schema,
    // and with no schema at all it still has titles to show.
    expect(findViewKind('list')?.configures).toBeNull();

    expect(findViewKind('board')?.configures?.field).toBe('groupBy');
    expect(findViewKind('calendar')?.configures?.field).toBe('dateProperty');
  });

  it('lets a board be configured only from a select, and a calendar only from a date', () => {
    // This is the same rule the server enforces on write. Offering a property the kind cannot use
    // would let somebody build a view that stores fine and then refuses to draw.
    const board = findViewKind('board')?.configures;
    const calendar = findViewKind('calendar')?.configures;

    const select = {
      key: 'status',
      label: 'Status',
      type: 'select',
      options: ['Doing'],
      required: false,
    };
    const date = { key: 'due', label: 'Due', type: 'date', options: [], required: false };
    const text = { key: 'note', label: 'Note', type: 'text', options: [], required: false };

    expect(board?.accepts(select)).toBe(true);
    expect(board?.accepts(date)).toBe(false);
    expect(board?.accepts(text)).toBe(false);

    expect(calendar?.accepts(date)).toBe(true);
    expect(calendar?.accepts(select)).toBe(false);
  });

  it('clears the column order when a board changes the property it groups by', () => {
    // The order belonged to the old property. Carried across, it would filter the new one down to
    // values it does not have, and the board would draw empty.
    expect(findViewKind('board')?.configures?.clears).toEqual({ groupOrder: [] });

    // A calendar has nothing that outlives its property, so it clears nothing.
    expect(findViewKind('calendar')?.configures?.clears).toBeUndefined();
  });
});
