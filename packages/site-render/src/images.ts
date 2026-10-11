import { createHash } from 'node:crypto';

import { sanitizeSvg, UnsafeSvg } from './svg.js';

/**
 * Removing what an image says about where and when it was taken, before it is published.
 *
 * A phone photo's EXIF block routinely carries GPS coordinates; a published site must never carry
 * them. Each format is rewritten segment by segment rather than decoded, so pixels are never
 * re-encoded and the output is byte-stable for the same input:
 *
 * - JPEG: APP1 (EXIF, XMP), APP3 to APP13 (vendor metadata, IPTC) and COM are dropped. APP0
 *   (JFIF), APP2 (ICC colour profile) and APP14 (Adobe colour transform) are kept, because the
 *   picture renders wrongly without them. If the EXIF orientation was not 1, a minimal APP1
 *   carrying only that tag is written back, so a portrait photo stays upright.
 * - PNG: `eXIf`, `tEXt`, `zTXt`, `iTXt` and `tIME` chunks are dropped.
 * - WebP: `EXIF` and `XMP ` chunks are dropped and their VP8X flags cleared.
 * - SVG (a captured Mermaid diagram): parsed and rewritten through the allowlist in `svg.ts`.
 *
 * Anything else, or a file that does not parse as what it claims to be, throws
 * {@link UnsupportedImage}; the caller leaves the image out and reports it.
 */

export class UnsupportedImage extends Error {
  override readonly name = 'UnsupportedImage';
}

export interface StrippedImage {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly ext: 'jpg' | 'png' | 'webp' | 'svg';
  readonly mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/svg+xml';
  /** Display size, with EXIF orientation applied. Null when the header does not say. */
  readonly width: number | null;
  readonly height: number | null;
  /** For an SVG, the Mermaid source digest it was captured from, if it carries one. */
  readonly sourceSha256?: string | null;
}

export function stripImageMetadata(bytes: Uint8Array, mediaType: string): StrippedImage {
  switch (mediaType) {
    case 'image/jpeg':
      return finish(stripJpeg(bytes), 'jpg', 'image/jpeg');
    case 'image/png':
      return finish(stripPng(bytes), 'png', 'image/png');
    case 'image/webp':
      return finish(stripWebp(bytes), 'webp', 'image/webp');
    case 'image/svg+xml':
      return sanitizedSvg(bytes);
    default:
      throw new UnsupportedImage(`Images of type ${mediaType} cannot be published.`);
  }
}

function sanitizedSvg(bytes: Uint8Array): StrippedImage {
  try {
    const clean = sanitizeSvg(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return {
      ...finish(
        { bytes: new TextEncoder().encode(clean.svg), width: clean.width, height: clean.height },
        'svg',
        'image/svg+xml',
      ),
      sourceSha256: clean.sourceSha256,
    };
  } catch (error) {
    if (error instanceof UnsafeSvg || error instanceof TypeError) {
      throw new UnsupportedImage(`A diagram could not be published: ${error.message}`);
    }
    throw error;
  }
}

interface Stripped {
  readonly bytes: Uint8Array;
  readonly width: number | null;
  readonly height: number | null;
}

function finish(
  stripped: Stripped,
  ext: StrippedImage['ext'],
  mediaType: StrippedImage['mediaType'],
): StrippedImage {
  return {
    ...stripped,
    ext,
    mediaType,
    sha256: createHash('sha256').update(stripped.bytes).digest('hex'),
  };
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u16be(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
}

function u32be(bytes: Uint8Array, at: number): number {
  return (u16be(bytes, at) * 0x10000 + u16be(bytes, at + 2)) >>> 0;
}

function u32le(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16)) +
    (bytes[at + 3] ?? 0) * 0x1000000
  );
}

function u24le(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16);
}

// ---------------------------------------------------------------------------------------------
// JPEG

const KEPT_APP = new Set([0xe0, 0xe2, 0xee]);
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function stripJpeg(bytes: Uint8Array): Stripped {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new UnsupportedImage('This file is not a JPEG.');
  }
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let orientation = 1;
  let width: number | null = null;
  let height: number | null = null;
  let at = 2;

  for (;;) {
    if (at + 4 > bytes.length || bytes[at] !== 0xff) {
      throw new UnsupportedImage('This JPEG ends before its image data.');
    }
    const marker = bytes[at + 1] ?? 0;
    if (marker === 0xff) {
      at += 1; // fill byte
      continue;
    }
    const length = u16be(bytes, at + 2);
    const end = at + 2 + length;
    if (length < 2 || end > bytes.length) {
      throw new UnsupportedImage('This JPEG has a segment longer than the file.');
    }
    const segment = bytes.subarray(at, end);

    if (marker === 0xda) {
      // Start of scan: everything from here is image data, copied verbatim.
      parts.push(bytes.subarray(at));
      break;
    }
    if (marker === 0xe1) {
      orientation = exifOrientation(bytes.subarray(at + 4, end)) ?? orientation;
    } else if (SOF.has(marker)) {
      height = u16be(bytes, at + 5);
      width = u16be(bytes, at + 7);
      parts.push(segment);
    } else if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) {
      if (KEPT_APP.has(marker)) {
        parts.push(segment);
      }
    } else {
      parts.push(segment);
    }
    at = end;
  }

  if (orientation !== 1) {
    parts.splice(1, 0, orientationSegment(orientation));
  }
  const turned = orientation >= 5 && orientation <= 8;
  return { bytes: concat(parts), width: turned ? height : width, height: turned ? width : height };
}

/** The orientation tag of an APP1 EXIF payload, or null when it has none. */
function exifOrientation(payload: Uint8Array): number | null {
  const header = String.fromCharCode(...payload.subarray(0, 6));
  if (header !== 'Exif\0\0') {
    return null;
  }
  const tiff = payload.subarray(6);
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  if (!little && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) {
    return null;
  }
  const u16 = (at: number) =>
    little ? (tiff[at] ?? 0) | ((tiff[at + 1] ?? 0) << 8) : u16be(tiff, at);
  const u32 = (at: number) => (little ? u32le(tiff, at) : u32be(tiff, at));
  const ifd = u32(4);
  const count = u16(ifd);
  for (let entry = 0; entry < count; entry += 1) {
    const at = ifd + 2 + entry * 12;
    if (at + 12 > tiff.length) {
      return null;
    }
    if (u16(at) === 0x0112) {
      const value = u16(at + 8);
      return value >= 1 && value <= 8 ? value : null;
    }
  }
  return null;
}

/** A big-endian APP1 holding one IFD with one entry: the orientation. */
function orientationSegment(orientation: number): Uint8Array {
  const tiff = [
    0x4d,
    0x4d,
    0x00,
    0x2a,
    0x00,
    0x00,
    0x00,
    0x08, // header, IFD0 at 8
    0x00,
    0x01, // one entry
    0x01,
    0x12,
    0x00,
    0x03,
    0x00,
    0x00,
    0x00,
    0x01,
    0x00,
    orientation,
    0x00,
    0x00, // SHORT
    0x00,
    0x00,
    0x00,
    0x00, // no next IFD
  ];
  const payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
  const length = payload.length + 2;
  return Uint8Array.from([0xff, 0xe1, length >> 8, length & 0xff, ...payload]);
}

// ---------------------------------------------------------------------------------------------
// PNG

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_DROPPED = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

function stripPng(bytes: Uint8Array): Stripped {
  if (!PNG_SIGNATURE.every((value, index) => bytes[index] === value)) {
    throw new UnsupportedImage('This file is not a PNG.');
  }
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  let width: number | null = null;
  let height: number | null = null;
  let at = 8;
  let ended = false;

  while (at < bytes.length) {
    const length = u32be(bytes, at);
    const end = at + 12 + length;
    if (end > bytes.length) {
      throw new UnsupportedImage('This PNG has a chunk longer than the file.');
    }
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (type === 'IHDR') {
      width = u32be(bytes, at + 8);
      height = u32be(bytes, at + 12);
    }
    if (!PNG_DROPPED.has(type)) {
      parts.push(bytes.subarray(at, end));
    }
    at = end;
    if (type === 'IEND') {
      ended = true;
      break;
    }
  }
  if (!ended || width === null) {
    throw new UnsupportedImage('This PNG is incomplete.');
  }
  return { bytes: concat(parts), width, height };
}

// ---------------------------------------------------------------------------------------------
// WebP

function stripWebp(bytes: Uint8Array): Stripped {
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WEBP') {
    throw new UnsupportedImage('This file is not a WebP image.');
  }
  const chunks: Uint8Array[] = [];
  let width: number | null = null;
  let height: number | null = null;
  let at = 12;

  while (at + 8 <= bytes.length) {
    const fourcc = tag(at);
    const size = u32le(bytes, at + 4);
    const end = at + 8 + size + (size % 2);
    if (at + 8 + size > bytes.length) {
      throw new UnsupportedImage('This WebP image has a chunk longer than the file.');
    }
    const chunk = bytes.slice(at, Math.min(end, bytes.length));

    if (fourcc === 'VP8X') {
      chunk[8] = (chunk[8] ?? 0) & ~0x0c; // clear the EXIF and XMP flags
      width = u24le(bytes, at + 12) + 1;
      height = u24le(bytes, at + 15) + 1;
    } else if (fourcc === 'VP8 ' && width === null) {
      width = ((bytes[at + 14] ?? 0) | ((bytes[at + 15] ?? 0) << 8)) & 0x3fff;
      height = ((bytes[at + 16] ?? 0) | ((bytes[at + 17] ?? 0) << 8)) & 0x3fff;
    } else if (fourcc === 'VP8L' && width === null) {
      const bits = u32le(bytes, at + 9);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    }
    if (fourcc !== 'EXIF' && fourcc !== 'XMP ') {
      chunks.push(chunk);
    }
    at = end;
  }

  const body = concat(chunks);
  const header = new Uint8Array(12);
  header.set([0x52, 0x49, 0x46, 0x46], 0);
  const riff = body.length + 4;
  header.set([riff & 0xff, (riff >> 8) & 0xff, (riff >> 16) & 0xff, (riff >>> 24) & 0xff], 4);
  header.set([0x57, 0x45, 0x42, 0x50], 8);
  return { bytes: concat([header, body]), width, height };
}
