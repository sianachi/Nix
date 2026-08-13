import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import type { FontFaces } from 'pdfmake';
import { decompress } from 'wawoff2';

/**
 * Nunito Sans, for a page.
 *
 * **The same bytes the browser renders, decompressed rather than converted.** CLAUDE.md allows one
 * typeface and no font CDN; `@fontsource/nunito-sans` is where the web app already gets it, and
 * woff2 is a compressed sfnt - so what happens below is decompression, and the outlines in a PDF
 * are byte-for-byte the outlines on screen. Nothing is re-drawn, re-hinted or subset differently.
 *
 * **Why not the variable font Google Fonts now ships.** pdfmake selects a weight by handing PDFKit
 * a different font per slot, and PDFKit takes bytes rather than a font object - so a variable file
 * would have to be instanced and re-serialised, and `fontkit@2.0.4`'s subset encoder is broken
 * against the `restructure@3` it declares. The static per-weight faces sidestep the whole question.
 *
 * **Why not pdfmake's bundled Roboto.** It is a second typeface, which the design language does not
 * have.
 */

const require = createRequire(import.meta.url);

/**
 * pdfmake's four slots, mapped to the weights the interface uses.
 *
 * 700 is `--font-heading-weight`, so a heading in a PDF is bold for the same reason it is bold on
 * screen. 600 is imported by the web app and deliberately absent here: pdfmake has four slots per
 * family, and spending one on a weight no print style asks for would cost the italic.
 */
const FACES = {
  normal: '400-normal',
  bold: '700-normal',
  italics: '400-italic',
  bolditalics: '700-italic',
} as const;

export const FONT_FAMILY = 'NunitoSans';

let faces: Promise<FontFaces> | null = null;

/**
 * The four faces, decompressed once per process.
 *
 * Memoised on the promise rather than the result, so two exports starting at the same moment share
 * one decompression instead of racing into two. A converter is meant to be free of I/O and this is
 * the one exception - reading its own package's bundled fonts, from disk, never from the network -
 * which is why it is quarantined here rather than reached for from a node handler.
 */
export async function loadFonts(): Promise<FontFaces> {
  faces ??= readFaces();
  return await faces;
}

async function readFaces(): Promise<FontFaces> {
  const [normal, bold, italics, bolditalics] = await Promise.all(
    [FACES.normal, FACES.bold, FACES.italics, FACES.bolditalics].map(readFace),
  );

  if (
    normal === undefined ||
    bold === undefined ||
    italics === undefined ||
    bolditalics === undefined
  ) {
    throw new Error('Nunito Sans could not be read; a PDF export needs all four faces.');
  }

  return { normal, bold, italics, bolditalics };
}

async function readFace(name: string): Promise<Buffer> {
  // Resolved through the module system rather than joined onto a relative path, so this keeps
  // working from `dist/` and from a pnpm store where the package is a symlink somewhere else.
  const path = require.resolve(`@fontsource/nunito-sans/files/nunito-sans-latin-${name}.woff2`);

  return Buffer.from(await decompress(await readFile(path)));
}
