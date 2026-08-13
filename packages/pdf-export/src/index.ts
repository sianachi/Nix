/**
 * The document schema, mapped onto pdfmake.
 *
 * A page is not the editor: headless Chromium was removed from this product for footprint, so an
 * export is a documented transformation with its own print rules rather than a screenshot. What is
 * kept faithfully is what carries meaning - the typeface, the weight that tells a heading from body
 * text, and the colour roles, all from `@nix/design-tokens`. What cannot survive the trip is stated
 * before the export runs and listed again in the file itself. See ADR-0035.
 */

export { pdfConverter } from './converter.js';
export type { PdfNode } from './content.js';
export { nodeHandlers } from './nodes.js';
