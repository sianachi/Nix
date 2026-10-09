import { describe, expect, it } from 'vitest';

import type { StructureFilterEntry, StructureView } from '../types.js';
import { refuseViews } from './view-rules.js';

/**
 * The query grammar this package ports from Core (`QueryOperators`, `QueryFields`, `QueryRules`):
 * the thirteen operators, the day tokens, the structural `$` fields on queries only, and one
 * level of "any of" groups counted toward the eight-filter ceiling.
 */
function view(kind: string, filters: StructureFilterEntry[]): StructureView {
  return {
    id: 'v',
    name: 'V',
    kind,
    columns: [],
    groupBy: null,
    groupOrder: [],
    dateProperty: null,
    sortBy: null,
    sortDescending: false,
    mode: null,
    coverProperty: null,
    endDateProperty: null,
    cardSize: null,
    layout: null,
    filters,
  };
}

const refuse = (kind: string, filters: StructureFilterEntry[]) =>
  refuseViews([view(kind, filters)], [], null);

describe('query filter rules', () => {
  it.each([
    ['contains', 'plan'],
    ['not-contains', 'plan'],
    ['greater-than', '2.5'],
    ['less-than', '-3'],
    ['is-empty', ''],
    ['is-not-empty', ''],
    ['within-last', '7'],
    ['on', 'start-of-week'],
    ['before', 'same-day-last-month'],
  ])('accepts %s %s on a query view', (operator, value) => {
    expect(refuse('query', [{ property: 'due', operator, value }])).toBeNull();
  });

  it.each([
    ['greater-than', 'lots'],
    ['is-empty', 'x'],
    ['within-last', '0'],
    ['on', 'yesterday'],
  ])('refuses %s %s', (operator, value) => {
    expect(refuse('query', [{ property: 'due', operator, value }])).not.toBeNull();
  });

  it('accepts the structural fields on a query and refuses them elsewhere', () => {
    const filters = [
      { property: '$type', operator: 'equals', value: 'task' },
      { property: '$done', operator: 'not-equals', value: 'true' },
      { property: '$inside', operator: 'equals', value: '7b7b7000-1111-4111-8111-7b7b70000001' },
      { property: '$created', operator: 'within-last', value: '7' },
    ];
    expect(refuse('query', filters)).toBeNull();
    expect(refuse('list', filters)).toMatch(/only a query/);
  });

  it.each([
    ['$tag', 'equals', 'x'],
    ['$type', 'contains', 'task'],
    ['$inside', 'equals', 'not-an-id'],
    ['$done', 'equals', 'yes'],
    ['$whatever', 'equals', 'x'],
  ])('refuses %s %s %s', (property, operator, value) => {
    expect(refuse('query', [{ property, operator, value }])).not.toBeNull();
  });

  it('accepts one level of any-of and counts its conditions toward the ceiling', () => {
    const group: StructureFilterEntry = {
      property: null,
      operator: null,
      value: null,
      any: [
        { property: 'status', operator: 'equals', value: 'Doing' },
        { property: 'status', operator: 'equals', value: 'Blocked' },
      ],
    };
    const plain = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        property: `k${String(index)}`,
        operator: 'is-not-empty',
        value: '',
      }));

    expect(refuse('query', [group, ...plain(6)])).toBeNull();
    expect(refuse('query', [group, ...plain(7)])).toMatch(/at most 8/);
    expect(refuse('query', [{ property: null, operator: null, value: null, any: [] }])).toMatch(
      /at least one/,
    );
  });
});
