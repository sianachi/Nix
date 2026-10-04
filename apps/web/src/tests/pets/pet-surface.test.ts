import { describe, expect, it } from 'vitest';
import { chatOpensAsPage, pageIsAvailable } from '../../pets/pet-surface';
describe('chat placement preference', () => {
  it.each([
    ['floating', false, false, false],
    ['floating', true, false, false],
    ['page-on-phones', false, false, false],
    ['page-on-phones', true, true, true],
    ['page', false, true, true],
    ['page', true, true, true],
    ['both', false, false, true],
    ['both', true, false, true],
  ] as const)('%s with narrow=%s', (surface, narrow, opens, available) => {
    expect(chatOpensAsPage(surface, narrow)).toBe(opens);
    expect(pageIsAvailable(surface, narrow)).toBe(available);
  });
});
