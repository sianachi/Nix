import { describe, expect, it } from 'vitest';
import { countLocalImages, countWikiLinks } from './scan.js';

describe('countWikiLinks', () => {
  it('counts each wiki link, and nothing that merely brackets', () => {
    expect(countWikiLinks('A [[One]] and [[Two|aliased]] but not [plain](x).')).toBe(2);
    expect(countWikiLinks('No links here.')).toBe(0);
  });
});

describe('countLocalImages', () => {
  it('counts image targets without a scheme as local, and leaves addresses alone', () => {
    const body =
      '![rel](./img.png) ![abs](/media/img.png) ![web](https://example.test/a.png) ' +
      '![data](data:image/png;base64,xyz) ![nix](nix://item/abc) plain ![alt] text';
    expect(countLocalImages(body)).toBe(2);
  });

  it('ignores a title after the target when deciding', () => {
    expect(countLocalImages('![a](./img.png "a title")')).toBe(1);
    expect(countLocalImages('![a](https://example.test/i.png "a title")')).toBe(0);
  });
});
