import { describe, expect, it } from 'vitest';

import { galleryColumnCount } from '../../../views/gallery/gallery-view';

describe('gallery responsive row geometry', () => {
  it('derives logical columns from the same breakpoints as the card classes', () => {
    expect(galleryColumnCount('small', 375)).toBe(2);
    expect(galleryColumnCount('small', 1_440)).toBe(6);
    expect(galleryColumnCount('medium', 375)).toBe(1);
    expect(galleryColumnCount('medium', 1_440)).toBe(4);
    expect(galleryColumnCount('large', 900)).toBe(1);
    expect(galleryColumnCount('large', 1_440)).toBe(3);
  });
});
