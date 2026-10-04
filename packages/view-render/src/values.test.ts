import type { PropertyDefinition } from '@nix/export';
import { describe, expect, it } from 'vitest';

import { formatValue } from './values.js';

const LONG_TEXT: PropertyDefinition = {
  key: 'notes',
  label: 'Notes',
  type: 'long_text',
  options: [],
  required: false,
};

describe('formatValue for long_text', () => {
  it('turns a line break into a single space so a row is not split by it', () => {
    expect(formatValue('first\nsecond', LONG_TEXT)).toBe('first second');
  });

  it('treats CRLF and a bare CR as one break, not two', () => {
    expect(formatValue('a\r\nb\rc', LONG_TEXT)).toBe('a b c');
  });

  it('collapses a run of blank lines and the indentation around a break into one space', () => {
    expect(formatValue('a  \n\n\n   b', LONG_TEXT)).toBe('a b');
  });

  it('trims a leading or trailing break instead of leaving a stray space', () => {
    expect(formatValue('\nhello\n', LONG_TEXT)).toBe('hello');
  });

  it('leaves single-line text alone, including its inner spaces', () => {
    expect(formatValue('one  two', LONG_TEXT)).toBe('one  two');
  });

  it('shows an empty value as nothing', () => {
    expect(formatValue('', LONG_TEXT)).toBe('');
    expect(formatValue(null, LONG_TEXT)).toBe('');
  });

  it('does not flatten line breaks for a plain text property', () => {
    // Only long_text is written for several lines; flattening elsewhere would hide a difference.
    expect(formatValue('a\nb', { ...LONG_TEXT, type: 'text' })).toBe('a\nb');
  });
});
