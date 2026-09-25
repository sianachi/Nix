import { describe, expect, it } from 'vitest';

import type { StructureProperty } from '../types.js';
import { mergeProperties } from './merge-properties.js';

/**
 * `packages/api-client/src/schemas/templates.ts` keeps its own copy of this same merge rule
 * (see the comment above `mergeProperties` there). These cases pin this copy's behaviour - nearest
 * wins, farther-first order - directly; they do not exercise api-client's copy, which has no
 * standalone test of its own (only an indirect one, through normalization, that never reaches the
 * replace-in-place path).
 */

const status: StructureProperty = {
  key: 'status',
  label: 'Status',
  type: 'select',
  options: [],
  required: false,
};

const owner: StructureProperty = {
  key: 'owner',
  label: 'Owner',
  type: 'text',
  options: [],
  required: false,
};

describe('mergeProperties', () => {
  it('keeps the inherited set unchanged when nothing is declared', () => {
    expect(mergeProperties([status], [])).toEqual([status]);
  });

  it('appends a declared property with no inherited match', () => {
    expect(mergeProperties([status], [owner])).toEqual([status, owner]);
  });

  it('replaces an inherited property of the same key in place, nearest wins', () => {
    const nearer: StructureProperty = { ...status, label: 'State', required: true };
    expect(mergeProperties([status, owner], [nearer])).toEqual([nearer, owner]);
  });

  it('orders the result farther-first: inherited properties before newly declared ones', () => {
    const extra: StructureProperty = {
      key: 'priority',
      label: 'Priority',
      type: 'priority',
      options: [],
      required: false,
    };
    expect(mergeProperties([status], [owner, extra])).toEqual([status, owner, extra]);
  });
});
