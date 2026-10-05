import { describe, expect, it } from 'vitest';

import { isAllowedLinkAddress } from './link-address.js';

describe('the shared link-address policy', () => {
  it.each([
    '/roadmap#quarter-three',
    '../planning/brief',
    '#decision',
    'https://example.test/plan',
    'http://example.test/plan',
    'mailto:editor@example.test',
    'tel:+442071234567',
  ])('accepts an address the Link extension can store: %s', (value) => {
    expect(isAllowedLinkAddress(value)).toBe(true);
  });

  it.each(['', '   ', 'javascript:alert(1)', 'data:text/html,unsafe', 'file:///tmp/plan'])(
    'refuses an empty or unsafe address: %s',
    (value) => {
      expect(isAllowedLinkAddress(value)).toBe(false);
    },
  );
});
