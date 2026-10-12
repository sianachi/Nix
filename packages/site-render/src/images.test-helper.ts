import { deflateSync } from 'node:zlib';

/** Small synthetic images for the metadata tests. Test-only. */

function u16(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

/** The GPS latitude rational the EXIF block carries, so a test can look for its bytes. */
export const GPS_MARKER = [0x00, 0x00, 0x00, 0x34, 0x00, 0x00, 0x00, 0x01]; // 52/1

/** A big-endian EXIF APP1 with an orientation tag and a GPS IFD holding a latitude. */
export function exifSegment(orientation: number): Uint8Array {
  // IFD0 at 8: 2 entries (orientation, GPS pointer). GPS IFD at 38: 1 entry (latitude, 3 rationals at 56).
  const tiff = [
    0x4d,
    0x4d,
    0x00,
    0x2a,
    ...u32(8),
    ...u16(2),
    ...u16(0x0112),
    ...u16(3),
    ...u32(1),
    ...u16(orientation),
    0,
    0,
    ...u16(0x8825),
    ...u16(4),
    ...u32(1),
    ...u32(38),
    ...u32(0),
    ...u16(1),
    ...u16(0x0002),
    ...u16(5),
    ...u32(3),
    ...u32(56),
    ...u32(0),
    ...GPS_MARKER,
    0,
    0,
    0,
    29,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    10,
    0,
    0,
    0,
    1,
  ];
  const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  return Uint8Array.from([0xff, 0xe1, ...u16(payload.length + 2), ...payload]);
}

/** A parseable (not decodable) JPEG: SOI, APP0, optional extra segments, SOF0, SOS, data, EOI. */
export function jpeg(width: number, height: number, ...segments: Uint8Array[]): Uint8Array {
  const app0 = [0xff, 0xe0, ...u16(16), 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const comment = [0xff, 0xfe, ...u16(9), ...Array.from('secret!', (c) => c.charCodeAt(0))];
  const sof = [
    0xff,
    0xc0,
    ...u16(17),
    8,
    ...u16(height),
    ...u16(width),
    3,
    1,
    0x11,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ];
  const sos = [
    0xff,
    0xda,
    ...u16(12),
    3,
    1,
    0,
    2,
    0x11,
    3,
    0x11,
    0,
    0x3f,
    0,
    0x12,
    0x34,
    0x56,
    0xff,
    0xd9,
  ];
  const extra = segments.flatMap((segment) => [...segment]);
  return Uint8Array.from([0xff, 0xd8, ...app0, ...extra, ...comment, ...sof, ...sos]);
}

function crc32(bytes: readonly number[]): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: readonly number[]): number[] {
  const body = [...Array.from(type, (c) => c.charCodeAt(0)), ...data];
  return [...u32(data.length), ...body, ...u32(crc32(body))];
}

/** A real 2x1 PNG carrying a tEXt chunk and a tIME chunk. */
export function png(): Uint8Array {
  const ihdr = [...u32(2), ...u32(1), 8, 2, 0, 0, 0];
  const pixels = [...deflateSync(Uint8Array.from([0, 255, 0, 0, 0, 0, 255]))];
  const text = Array.from('Comment\0Taken at 52.48 N', (c) => c.charCodeAt(0));
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk('IHDR', ihdr),
    ...chunk('tEXt', text),
    ...chunk('tIME', [7, 234, 10, 11, 12, 0, 0]),
    ...chunk('IDAT', pixels),
    ...chunk('IEND', []),
  ]);
}

/** A VP8X WebP shell with an EXIF chunk and its flag set; not decodable, but well formed. */
export function webp(): Uint8Array {
  const le32 = (value: number) => [
    value & 0xff,
    (value >> 8) & 0xff,
    (value >> 16) & 0xff,
    (value >>> 24) & 0xff,
  ];
  const vp8x = [
    ...Array.from('VP8X', (c) => c.charCodeAt(0)),
    ...le32(10),
    0x08,
    0,
    0,
    0,
    99,
    0,
    0,
    49,
    0,
    0,
  ];
  const exif = [
    ...Array.from('EXIF', (c) => c.charCodeAt(0)),
    ...le32(GPS_MARKER.length),
    ...GPS_MARKER,
  ];
  const body = [...Array.from('WEBP', (c) => c.charCodeAt(0)), ...vp8x, ...exif];
  return Uint8Array.from([
    ...Array.from('RIFF', (c) => c.charCodeAt(0)),
    ...le32(body.length),
    ...body,
  ]);
}

export function contains(haystack: Uint8Array, needle: readonly number[]): boolean {
  outer: for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return true;
  }
  return false;
}
