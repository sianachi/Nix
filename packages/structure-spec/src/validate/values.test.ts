import { describe, expect, it } from 'vitest';

import type { StructureProperty } from '../types.js';
import { validateValue } from './values.js';

function property(overrides: Partial<StructureProperty> & { type: string }): StructureProperty {
  return {
    key: overrides.key ?? 'field',
    label: overrides.label ?? 'Field',
    options: overrides.options ?? [],
    required: overrides.required ?? false,
    ...overrides,
  };
}

describe('validateValue', () => {
  it('accepts an explicit null for any type, matching PropertyValidator.IsAbsent', () => {
    for (const type of ['text', 'number', 'select', 'priority', 'formula', 'assignee']) {
      expect(validateValue(property({ type }), null)).toBeNull();
    }
  });

  it('accepts text and refuses a number', () => {
    const text = property({ type: 'text' });
    expect(validateValue(text, 'hello')).toBeNull();
    expect(validateValue(text, 5)).toBe('Field must be text.');
  });

  it('accepts a finite number and refuses text and NaN', () => {
    const number = property({ type: 'number' });
    expect(validateValue(number, 3.5)).toBeNull();
    expect(validateValue(number, '3.5')).toBe('Field must be a number.');
    expect(validateValue(number, Number.NaN)).toBe('Field must be a number.');
  });

  it('accepts a boolean for checkbox and completion, refuses a string', () => {
    const checkbox = property({ type: 'checkbox' });
    expect(validateValue(checkbox, true)).toBeNull();
    expect(validateValue(checkbox, 'true')).toBe('Field must be true or false.');

    const completion = property({ type: 'completion' });
    expect(validateValue(completion, false)).toBeNull();
    expect(validateValue(completion, 1)).toBe('Field must be true or false.');
  });

  it('accepts a real calendar day and refuses an invalid one, for date, due_date and start_date', () => {
    for (const type of ['date', 'due_date', 'start_date']) {
      const date = property({ type });
      expect(validateValue(date, '2026-03-17')).toBeNull();
      expect(validateValue(date, '2026-02-30')).toBe('Field must be a date, as yyyy-MM-dd.');
      expect(validateValue(date, '17-03-2026')).toBe('Field must be a date, as yyyy-MM-dd.');
    }
  });

  it('accepts a timestamp whose offset matches its zone and refuses one that does not', () => {
    const timestamp = property({ type: 'timestamp' });
    // Europe/London is on summer time (+01:00) in July.
    expect(validateValue(timestamp, '2026-07-17T09:00:00+01:00[Europe/London]')).toBeNull();
    expect(validateValue(timestamp, '2026-07-17T09:00:00+00:00[Europe/London]')).toBe(
      "Field has an offset that 'Europe/London' was not using at that moment.",
    );
    expect(validateValue(timestamp, '2026-07-17T09:00:00+01:00[Nowhere/Fake]')).toBe(
      "Field names the time zone 'Nowhere/Fake', which is not one this build knows.",
    );
    expect(validateValue(timestamp, '2026-07-17T09:00:00+01:00')).toBe(
      'Field must be a time with its zone, as 2026-03-17T09:00:00+00:00[Europe/London].',
    );
  });

  it('refuses a timestamp on an impossible calendar day or clock time', () => {
    const timestamp = property({ type: 'timestamp' });
    // `new Date` alone would roll both of these over into a valid instant instead of refusing them.
    expect(validateValue(timestamp, '2026-02-30T09:00:00+00:00[UTC]')).toBe(
      'Field must be a time with its zone, as 2026-03-17T09:00:00+00:00[Europe/London].',
    );
    expect(validateValue(timestamp, '2026-07-17T24:00:00+00:00[UTC]')).toBe(
      'Field must be a time with its zone, as 2026-03-17T09:00:00+00:00[Europe/London].',
    );
  });

  it('refuses a zone id written in the wrong case or shaped like a bare offset', () => {
    const timestamp = property({ type: 'timestamp' });
    expect(validateValue(timestamp, '2026-07-17T09:00:00+01:00[europe/london]')).toBe(
      "Field names the time zone 'europe/london', which is not one this build knows.",
    );
    expect(validateValue(timestamp, '2026-07-17T09:00:00+01:00[+01:00]')).toBe(
      "Field names the time zone '+01:00', which is not one this build knows.",
    );
  });

  it('accepts an absolute http or https url and refuses everything else', () => {
    const url = property({ type: 'url' });
    expect(validateValue(url, 'https://example.com/page')).toBeNull();
    expect(validateValue(url, 'http://example.com')).toBeNull();
    expect(validateValue(url, '/relative/path')).toBe('Field must be an http or https address.');
    expect(validateValue(url, 'javascript:alert(1)')).toBe(
      'Field must be an http or https address.',
    );
  });

  it('accepts an http image or a nix-file reference and refuses other schemes', () => {
    const image = property({ type: 'image' });
    expect(validateValue(image, 'https://example.com/cover.png')).toBeNull();
    expect(validateValue(image, 'nix-file:0d9c9c3a-6d8a-4c8e-9a2e-8f2b6c9a1234')).toBeNull();
    expect(validateValue(image, 'nix-file:0D9C9C3A-6D8A-4C8E-9A2E-8F2B6C9A1234')).toBeNull();
    expect(validateValue(image, 'nix-file:not-a-uuid')).toBe(
      'Field must be a link to an image, over http or https.',
    );
    expect(validateValue(image, 'data:image/png;base64,aa')).toBe(
      'Field must be a link to an image, over http or https.',
    );
  });

  it('accepts a listed option for select and refuses one not offered', () => {
    const select = property({ type: 'select', options: ['To do', 'Done'] });
    expect(validateValue(select, 'Done')).toBeNull();
    expect(validateValue(select, 'Archived')).toBe("Field does not offer 'Archived'.");
  });

  it('accepts a list of listed options for multi_select and refuses a duplicate', () => {
    const multiSelect = property({ type: 'multi_select', options: ['Red', 'Green', 'Blue'] });
    expect(validateValue(multiSelect, ['Red', 'Blue'])).toBeNull();
    expect(validateValue(multiSelect, ['Red', 'Purple'])).toBe("Field does not offer 'Purple'.");
    expect(validateValue(multiSelect, ['Red', 'Red'])).toBe("Field lists 'Red' more than once.");
  });

  it('accepts 1 to 4 for priority and refuses anything outside it', () => {
    const priority = property({ type: 'priority' });
    expect(validateValue(priority, 1)).toBeNull();
    expect(validateValue(priority, 4)).toBeNull();
    expect(validateValue(priority, 0)).toBe(
      'Field must be a whole number from 1 (most urgent) to 4.',
    );
    expect(validateValue(priority, 2.5)).toBe(
      'Field must be a whole number from 1 (most urgent) to 4.',
    );
  });

  it('accepts a non-negative number for estimate and refuses a negative one', () => {
    const estimate = property({ type: 'estimate' });
    expect(validateValue(estimate, 0)).toBeNull();
    expect(validateValue(estimate, -1)).toBe('Field must be a number of zero or more.');
  });

  it('always refuses a formula or rollup value', () => {
    expect(validateValue(property({ type: 'formula' }), 5)).toBe(
      'Field is computed and cannot be set.',
    );
    expect(validateValue(property({ type: 'rollup' }), 5)).toBe(
      'Field is computed and cannot be set.',
    );
  });

  it('always refuses an assignee value, even a well-formed one', () => {
    const assignee = property({ type: 'assignee' });
    expect(validateValue(assignee, '11111111-1111-4111-8111-111111111111')).toBe(
      "Field is a person's assignment; a pet request cannot set who something belongs to.",
    );
  });
});
