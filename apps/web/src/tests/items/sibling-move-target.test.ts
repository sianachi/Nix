import { describe, expect, it } from 'vitest';

import { siblingMoveTarget } from '../../items/sibling-move-target';

/**
 * The landing an up/down nudge produces among siblings - shared by the mobile move dialog and the
 * desktop tree's keyboard bindings, so it is proven once here rather than through either caller.
 */

const SIBLINGS = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

describe('siblingMoveTarget', () => {
  describe('moving up', () => {
    it('lands after the sibling two slots up, for a middle item', () => {
      expect(siblingMoveTarget(SIBLINGS, 1, 'up')).toBeNull();
    });

    it('lands after the sibling two slots up, for the last item', () => {
      expect(siblingMoveTarget(SIBLINGS, 2, 'up')).toBe('a');
    });

    it('has nowhere to land for the first item', () => {
      expect(siblingMoveTarget(SIBLINGS, 0, 'up')).toBeNull();
    });
  });

  describe('moving down', () => {
    it('lands after the very next sibling, for the first item', () => {
      expect(siblingMoveTarget(SIBLINGS, 0, 'down')).toBe('b');
    });

    it('lands after the very next sibling, for a middle item', () => {
      expect(siblingMoveTarget(SIBLINGS, 1, 'down')).toBe('c');
    });

    it('has nowhere to land for the last item', () => {
      expect(siblingMoveTarget(SIBLINGS, 2, 'down')).toBeNull();
    });
  });
});
