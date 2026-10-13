import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { inflateSync } from 'node:zlib';

import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { SITE_PALETTE } from '@nix/design-tokens/site';

import { escapeHtml } from '../html/escape.js';

/**
 * The link-preview card every page without a cover shares as its `og:image`: 1200 by 630, the
 * site's name with the Nix tree mark in its accent, the page title wrapped to at most three lines,
 * and a caption (a date or a section). Drawn as SVG and rasterised by resvg compiled to WASM, so a
 * build needs no browser and no native module; the theme's own Nunito Sans is the only font, so the
 * same input gives the same PNG bytes on every machine.
 */

export const PREVIEW_WIDTH = 1200;
export const PREVIEW_HEIGHT = 630;

export interface PreviewCard {
  readonly siteName: string;
  readonly title: string;
  readonly caption: string;
  readonly accent: string;
}

/** SVG to PNG bytes. */
export type PreviewRasterizer = (svg: string) => Uint8Array;

const require = createRequire(import.meta.url);
const TITLE_SIZE = 68;
const TITLE_LINES = 3;
const TEXT_WIDTH = 1040;

/**
 * A rough advance width in em for Nunito Sans ExtraBold. Wrapping only needs to keep lines inside
 * the card, so a per-class estimate is enough; resvg still shapes the text itself.
 */
function advance(char: string): number {
  if (/[iljtf.,:;'!|() ]/.test(char)) {
    return 0.3;
  }
  if (/[mwMW@]/.test(char)) {
    return 0.88;
  }
  return /[A-Z0-9]/.test(char) ? 0.66 : 0.56;
}

function width(text: string, size: number): number {
  let total = 0;
  for (const char of text) {
    total += advance(char);
  }
  return total * size;
}

/** Greedy word wrap into at most `lines` lines; the last kept line ends in an ellipsis when cut. */
export function wrapTitle(title: string, size = TITLE_SIZE, lines = TITLE_LINES): string[] {
  const words = title
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  const out: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line.length === 0 ? word : `${line} ${word}`;
    if (width(next, size) <= TEXT_WIDTH || line.length === 0) {
      line = next;
    } else {
      out.push(line);
      line = word;
    }
  }
  if (line.length > 0) {
    out.push(line);
  }
  const kept = out.slice(0, lines).map((text) => {
    let clipped = text;
    while (width(clipped, size) > TEXT_WIDTH && clipped.length > 1) {
      clipped = clipped.slice(0, -1);
    }
    return clipped === text ? text : `${clipped.trimEnd()}\u2026`;
  });
  if (out.length > lines && kept.length > 0) {
    let last = kept[kept.length - 1] ?? '';
    while (width(`${last}\u2026`, size) > TEXT_WIDTH && last.length > 1) {
      last = last.slice(0, -1);
    }
    kept[kept.length - 1] = `${last.replace(/\u2026$/, '').trimEnd()}\u2026`;
  }
  return kept;
}

function clip(text: string, size: number, limit: number): string {
  let out = text;
  while (width(out, size) > limit && out.length > 1) {
    out = out.slice(0, -1);
  }
  return out === text ? text : `${out.trimEnd()}\u2026`;
}

/** Characters XML 1.0 forbids; one in a title would make resvg refuse the card and fail the build. */
// eslint-disable-next-line no-control-regex -- Justification: removing control characters is the point.
const NOT_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g;

export function previewSvg(input: PreviewCard): string {
  const card = {
    ...input,
    siteName: input.siteName.replace(NOT_XML, ''),
    title: input.title.replace(NOT_XML, ''),
    caption: input.caption.replace(NOT_XML, ''),
  };
  const { ground, text, muted, border } = SITE_PALETTE.light;
  const accent = /^#[0-9a-fA-F]{6}$/.test(card.accent) ? card.accent : text;
  const lines = wrapTitle(card.title.length > 0 ? card.title : card.siteName);
  const lineHeight = Math.round(TITLE_SIZE * 1.15);
  const titleTop = 330 - ((lines.length - 1) * lineHeight) / 2;
  const title = lines
    .map(
      (line, index) =>
        `<text x="80" y="${String(titleTop + index * lineHeight)}" font-size="${String(TITLE_SIZE)}" font-weight="800" fill="${text}">${escapeHtml(line)}</text>`,
    )
    .join('');
  const caption =
    card.caption.length === 0
      ? ''
      : `<text x="80" y="548" font-size="30" font-weight="400" fill="${muted}">${escapeHtml(clip(card.caption, 30, TEXT_WIDTH))}</text>`;
  // The header mark, drawn large: a filled item, a hairline elbow down to a hollow child.
  const mark = `<g transform="translate(80 72) scale(2.6)"><rect width="10" height="10" rx="2" fill="${accent}"/><path d="M5 10v8.5h9" fill="none" stroke="${accent}" stroke-width="1.5"/><rect x="14.5" y="14.5" width="6.5" height="6.5" rx="1.5" fill="none" stroke="${accent}" stroke-width="1.5"/></g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${String(PREVIEW_WIDTH)}" height="${String(PREVIEW_HEIGHT)}" viewBox="0 0 ${String(PREVIEW_WIDTH)} ${String(PREVIEW_HEIGHT)}" font-family="Nunito Sans"><rect width="100%" height="100%" fill="${ground}"/><rect width="100%" height="12" fill="${accent}"/>${mark}<text x="160" y="118" font-size="34" font-weight="700" fill="${text}">${escapeHtml(clip(card.siteName, 34, 960))}</text>${title}<line x1="80" x2="1120" y1="500" y2="500" stroke="${border}" stroke-width="2"/>${caption}</svg>`;
}

/** A WOFF 1.0 font as the plain SFNT (TTF/OTF) resvg reads: each table inflated, offsets rebuilt. */
export function woffToSfnt(woff: Uint8Array): Uint8Array {
  const view = new DataView(woff.buffer, woff.byteOffset, woff.byteLength);
  if (view.getUint32(0) !== 0x774f4646) {
    throw new Error('Not a WOFF font.');
  }
  const count = view.getUint16(12);
  const tables = Array.from({ length: count }, (_, index) => {
    const at = 44 + index * 20;
    const offset = view.getUint32(at + 4);
    const compressed = view.getUint32(at + 8);
    const length = view.getUint32(at + 12);
    const raw = woff.subarray(offset, offset + compressed);
    return {
      tag: view.getUint32(at),
      checksum: view.getUint32(at + 16),
      data: compressed < length ? new Uint8Array(inflateSync(raw)) : raw,
    };
  });
  let size = 12 + 16 * count;
  for (const table of tables) {
    size += (table.data.length + 3) & ~3;
  }
  const out = new Uint8Array(size);
  const write = new DataView(out.buffer);
  const power = 2 ** Math.floor(Math.log2(count));
  write.setUint32(0, view.getUint32(4));
  write.setUint16(4, count);
  write.setUint16(6, power * 16);
  write.setUint16(8, Math.log2(power));
  write.setUint16(10, count * 16 - power * 16);
  let offset = 12 + 16 * count;
  tables.forEach((table, index) => {
    const at = 12 + index * 16;
    write.setUint32(at, table.tag);
    write.setUint32(at + 4, table.checksum);
    write.setUint32(at + 8, offset);
    write.setUint32(at + 12, table.data.length);
    out.set(table.data, offset);
    offset += (table.data.length + 3) & ~3;
  });
  return out;
}

let ready: Promise<PreviewRasterizer> | null = null;

/**
 * The rasteriser, loaded once per process: the WASM module and the three weights the card uses.
 * Async because WASM instantiation is; `renderSite` itself stays synchronous and takes the result.
 */
export function loadPreviewRasterizer(): Promise<PreviewRasterizer> {
  ready ??= (async () => {
    await initWasm(readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));
    const fontBuffers = ['400', '700', '800'].map((weight) =>
      woffToSfnt(
        new Uint8Array(
          readFileSync(
            require.resolve(
              `@fontsource/nunito-sans/files/nunito-sans-latin-${weight}-normal.woff`,
            ),
          ),
        ),
      ),
    );
    return (svg: string): Uint8Array => {
      const resvg = new Resvg(svg, {
        font: { fontBuffers, defaultFontFamily: 'Nunito Sans', sansSerifFamily: 'Nunito Sans' },
        fitTo: { mode: 'original' },
      });
      try {
        const image = resvg.render();
        try {
          return image.asPng();
        } finally {
          image.free();
        }
      } finally {
        resvg.free();
      }
    };
  })();
  // A failed load is not cached, so the next build tries again.
  ready.catch(() => {
    ready = null;
  });
  return ready;
}
