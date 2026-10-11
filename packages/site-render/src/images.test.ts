import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { GPS_MARKER, contains, exifSegment, jpeg, png, webp } from './images.test-helper.js';
import { UnsupportedImage, stripImageMetadata } from './images.js';

const EXIF = [0x45, 0x78, 0x69, 0x66, 0, 0];

describe('stripImageMetadata', () => {
  it('drops GPS and comments from a JPEG and keeps an upright orientation implicit', () => {
    const stripped = stripImageMetadata(jpeg(40, 30, exifSegment(1)), 'image/jpeg');
    expect(contains(stripped.bytes, GPS_MARKER)).toBe(false);
    expect(contains(stripped.bytes, EXIF)).toBe(false);
    expect(
      contains(
        stripped.bytes,
        Array.from('secret!', (c) => c.charCodeAt(0)),
      ),
    ).toBe(false);
    expect([stripped.width, stripped.height]).toEqual([40, 30]);
  });

  it.each([3, 6, 8])('keeps orientation %i and nothing else of the EXIF block', (orientation) => {
    const stripped = stripImageMetadata(jpeg(40, 30, exifSegment(orientation)), 'image/jpeg');
    expect(contains(stripped.bytes, GPS_MARKER)).toBe(false);
    expect(
      contains(stripped.bytes, [0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation]),
    ).toBe(true);
    const turned = orientation !== 3;
    expect([stripped.width, stripped.height]).toEqual(turned ? [30, 40] : [40, 30]);
  });

  it('keeps the image data and is stable for the same input', () => {
    const input = jpeg(8, 8, exifSegment(1));
    const first = stripImageMetadata(input, 'image/jpeg');
    expect(first.sha256).toBe(stripImageMetadata(input, 'image/jpeg').sha256);
    expect(contains(first.bytes, [0x12, 0x34, 0x56, 0xff, 0xd9])).toBe(true);
    expect(first.ext).toBe('jpg');
  });

  it('strips the GPS block from the blog fixture photo', () => {
    const photo = readFileSync(
      join(import.meta.dirname, '__fixtures__/blog/files/0199c0de-0200-7000-8000-000000000707.jpg'),
    );
    expect(contains(photo, EXIF)).toBe(true);
    const stripped = stripImageMetadata(new Uint8Array(photo), 'image/jpeg');
    expect(contains(stripped.bytes, EXIF)).toBe(false);
    expect(
      contains(
        stripped.bytes,
        Array.from('Bench camera', (c) => c.charCodeAt(0)),
      ),
    ).toBe(false);
    expect([stripped.width, stripped.height]).toEqual([1600, 1000]);
  });

  it('drops PNG text and time chunks', () => {
    const stripped = stripImageMetadata(png(), 'image/png');
    expect(
      contains(
        stripped.bytes,
        Array.from('tEXt', (c) => c.charCodeAt(0)),
      ),
    ).toBe(false);
    expect(
      contains(
        stripped.bytes,
        Array.from('tIME', (c) => c.charCodeAt(0)),
      ),
    ).toBe(false);
    expect(
      contains(
        stripped.bytes,
        Array.from('IDAT', (c) => c.charCodeAt(0)),
      ),
    ).toBe(true);
    expect([stripped.width, stripped.height]).toEqual([2, 1]);
  });

  it('drops WebP EXIF and clears its flag', () => {
    const stripped = stripImageMetadata(webp(), 'image/webp');
    expect(contains(stripped.bytes, GPS_MARKER)).toBe(false);
    expect(stripped.bytes[20]).toBe(0);
    expect([stripped.width, stripped.height]).toEqual([100, 50]);
    expect(new DataView(stripped.bytes.buffer).getUint32(4, true)).toBe(stripped.bytes.length - 8);
  });

  it('refuses what it cannot read', () => {
    expect(() => stripImageMetadata(Uint8Array.from([1, 2, 3]), 'image/jpeg')).toThrow(
      UnsupportedImage,
    );
    expect(() => stripImageMetadata(png(), 'image/gif')).toThrow(UnsupportedImage);
    expect(() => stripImageMetadata(png().subarray(0, 30), 'image/png')).toThrow(UnsupportedImage);
  });

  it('re-sanitises a captured diagram and reads its size and source stamp', () => {
    const hash = 'b'.repeat(64);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 10" data-nix-source-sha256="${hash}" onload="x()"><script>x()</script><rect width="1"/></svg>`;
    const image = stripImageMetadata(new TextEncoder().encode(svg), 'image/svg+xml');
    expect(image).toMatchObject({ ext: 'svg', width: 30, height: 10, sourceSha256: hash });
    expect(new TextDecoder().decode(image.bytes)).not.toMatch(/script|onload/);
    expect(() =>
      stripImageMetadata(Uint8Array.from([0x3c, 0x73, 0xff, 0xfe]), 'image/svg+xml'),
    ).toThrow(UnsupportedImage);
    expect(() =>
      stripImageMetadata(new TextEncoder().encode('<!DOCTYPE svg><svg/>'), 'image/svg+xml'),
    ).toThrow(UnsupportedImage);
  });
});
