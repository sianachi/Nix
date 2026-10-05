import { describe, expect, it } from 'vitest';

import { fieldsSpecSchema, formEditSpecSchema, recurrenceSpecSchema } from './edits.js';

const emptyForm = { pages: [{ title: 'Details', blocks: [{ heading: 'About' }] }] };

describe('Phase B edit schemas', () => {
  it('requires one to twenty added fields', () => {
    expect(fieldsSpecSchema.safeParse({ fields: [] }).success).toBe(false);
    expect(
      fieldsSpecSchema.safeParse({
        fields: Array.from({ length: 20 }, (_, index) => ({
          label: `Field ${String(index)}`,
          type: 'text',
        })),
      }).success,
    ).toBe(true);
    expect(
      fieldsSpecSchema.safeParse({
        fields: Array.from({ length: 21 }, (_, index) => ({
          label: `Field ${String(index)}`,
          type: 'text',
        })),
      }).success,
    ).toBe(false);
  });

  it('allows up to ten optional fields on a form edit', () => {
    expect(formEditSpecSchema.safeParse({ viewId: 'form', form: emptyForm }).success).toBe(true);
    expect(
      formEditSpecSchema.safeParse({
        viewId: 'form',
        form: emptyForm,
        fields: Array.from({ length: 10 }, (_, index) => ({
          label: `Field ${String(index)}`,
          type: 'text',
        })),
      }).success,
    ).toBe(true);
    expect(
      formEditSpecSchema.safeParse({
        viewId: 'form',
        form: emptyForm,
        fields: Array.from({ length: 11 }, (_, index) => ({
          label: `Field ${String(index)}`,
          type: 'text',
        })),
      }).success,
    ).toBe(false);
  });

  it('checks recurrence bounds, unique weekdays, and date shape', () => {
    expect(
      recurrenceSpecSchema.safeParse({ frequency: 'weekly', interval: 2, weekdays: [1, 4] })
        .success,
    ).toBe(true);
    expect(
      recurrenceSpecSchema.safeParse({ frequency: 'weekly', interval: 2, weekdays: [1, 1] })
        .success,
    ).toBe(false);
    expect(recurrenceSpecSchema.safeParse({ frequency: 'daily', interval: 367 }).success).toBe(
      false,
    );
    expect(
      recurrenceSpecSchema.safeParse({ frequency: 'daily', interval: 1, until: '2026-9-1' })
        .success,
    ).toBe(false);
  });
});
