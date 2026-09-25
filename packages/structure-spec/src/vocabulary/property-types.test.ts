import { describe, expect, it } from 'vitest';

import { isDateShaped, PROPERTY_TYPES, valueShapeOf } from './property-types.js';

describe('valueShapeOf', () => {
  const expected: Record<string, string> = {
    text: 'text',
    number: 'number',
    select: 'select',
    multi_select: 'multi_select',
    date: 'date',
    timestamp: 'timestamp',
    checkbox: 'checkbox',
    url: 'url',
    image: 'image',
    due_date: 'date',
    start_date: 'date',
    completion: 'checkbox',
    priority: 'number',
    estimate: 'number',
    assignee: 'text',
    formula: 'formula',
    rollup: 'rollup',
  };

  it.each(PROPERTY_TYPES.map((entry) => entry.value))('resolves the shape of %s', (type) => {
    expect(valueShapeOf(type)).toBe(expected[type]);
  });
});

describe('isDateShaped', () => {
  it('is true only for date, timestamp, due_date and start_date', () => {
    const dateShaped = new Set(['date', 'timestamp', 'due_date', 'start_date']);
    for (const entry of PROPERTY_TYPES) {
      expect(isDateShaped(entry.value)).toBe(dateShaped.has(entry.value));
    }
  });
});
