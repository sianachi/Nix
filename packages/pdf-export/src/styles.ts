import { PRINT_PALETTE } from '@nix/design-tokens/print';
import type { TableLayout } from 'pdfmake';

import { FONT_FAMILY } from './fonts.js';

/**
 * The print stylesheet.
 *
 * **A page is not the editor and this does not pretend otherwise.** Headless Chromium was removed
 * from this product for footprint, so an export is a documented transformation with its own rules
 * rather than a screenshot of the screen - the development document says so, and Typst is the named
 * upgrade path if typographic quality ever becomes the complaint. What is kept faithfully is what
 * carries meaning: the family, the weight that tells a heading from body text, and the colour roles.
 *
 * Sizes are in points, and they are print sizes rather than the screen scale converted. A document
 * read on paper at arm's length wants a smaller body than one read on a monitor.
 */

const BODY_SIZE = 10.5;

export const PAGE_MARGINS: readonly [number, number, number, number] = [56, 56, 56, 64];

export const DEFAULT_STYLE = {
  font: FONT_FAMILY,
  fontSize: BODY_SIZE,
  lineHeight: 1.35,
  color: PRINT_PALETTE.ink,
} as const;

export const STYLES = {
  title: { fontSize: 22, bold: true, margin: [0, 0, 0, 4] },

  // The item's place in the tree, under its title. Quiet, because it is context rather than content.
  breadcrumb: { fontSize: 8.5, color: PRINT_PALETTE.muted, margin: [0, 0, 0, 16] },

  h1: { fontSize: 16, bold: true, margin: [0, 14, 0, 5] },
  h2: { fontSize: 13.5, bold: true, margin: [0, 12, 0, 4] },
  h3: { fontSize: 11.5, bold: true, margin: [0, 10, 0, 3] },

  body: { margin: [0, 0, 0, 7] },

  // Monospace is deliberately not a second family: there is one typeface. Code is told apart by its
  // ground and its indent, which is what the editor does too.
  code: { fontSize: 9.5, margin: [0, 0, 0, 0], preserveLeadingSpaces: true },
  codeInline: { fontSize: 9.5, background: PRINT_PALETTE.codeFill },

  quote: { italics: true, color: PRINT_PALETTE.muted },

  // The tone's name, above a callout. On screen the tones differ by colour; the token sheet is mono,
  // so on paper the word is what distinguishes them - which is more legible, not less.
  eyebrow: { fontSize: 8, bold: true, color: PRINT_PALETTE.muted, margin: [0, 0, 0, 3] },

  link: { color: PRINT_PALETTE.accentText, decoration: 'underline' },
  reference: { color: PRINT_PALETTE.accentText },

  tableHeader: { bold: true },

  /** The summary of a disclosure, which on paper is always open. */
  summary: { bold: true, margin: [0, 0, 0, 3] },

  /** The closing report of what did not come across. */
  appendixTitle: { fontSize: 13.5, bold: true, margin: [0, 0, 0, 8] },
  appendixItem: { fontSize: 9.5, color: PRINT_PALETTE.muted, margin: [0, 0, 0, 5] },

  footer: { fontSize: 8, color: PRINT_PALETTE.muted },
} as const;

/**
 * Named table layouts.
 *
 * pdfmake resolves these by name at render time, which is the only way to give a table borders
 * without an inline layout object on every node - and it keeps the drawing rules in one place
 * rather than beside each block that happens to be a table underneath.
 */
export const TABLE_LAYOUTS: Readonly<Record<string, TableLayout>> = {
  /** An actual table: hairlines throughout, the header row on the surface tint. */
  grid: {
    hLineWidth: () => 0.5,
    vLineWidth: () => 0.5,
    hLineColor: () => PRINT_PALETTE.divider,
    vLineColor: () => PRINT_PALETTE.divider,
    fillColor: (rowIndex: number) => (rowIndex === 0 ? PRINT_PALETTE.surface : null),
    paddingLeft: () => 6,
    paddingRight: () => 6,
    paddingTop: () => 4,
    paddingBottom: () => 4,
  },

  /** A callout or a code block: one tinted cell with a rule down its left edge. */
  banded: {
    hLineWidth: () => 0,
    vLineWidth: (index: number) => (index === 0 ? 2 : 0),
    vLineColor: () => PRINT_PALETTE.accentFill,
    paddingLeft: () => 10,
    paddingRight: () => 10,
    paddingTop: () => 7,
    paddingBottom: () => 7,
  },

  /** A blockquote: the rule, and nothing else. */
  quoted: {
    hLineWidth: () => 0,
    vLineWidth: (index: number) => (index === 0 ? 2 : 0),
    vLineColor: () => PRINT_PALETTE.divider,
    paddingLeft: () => 12,
    paddingRight: () => 0,
    paddingTop: () => 2,
    paddingBottom: () => 2,
  },

  /** Columns rendered as a table, and a table nobody should see. */
  invisible: {
    hLineWidth: () => 0,
    vLineWidth: () => 0,
    paddingLeft: () => 0,
    paddingRight: () => 8,
    paddingTop: () => 0,
    paddingBottom: () => 0,
  },
};
