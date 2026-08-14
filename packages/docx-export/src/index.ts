/**
 * The document schema, mapped onto Open XML.
 *
 * A Word document is for editing elsewhere, which is a different promise from a PDF's: the mapping
 * favours structure that survives editing - real headings, real lists, real tables - over a faithful
 * picture of a page. Where Open XML has no equivalent at all, most visibly for the editor's
 * side-by-side columns, the difference is recorded rather than approximated silently. See ADR-0035.
 */

export { buildBlocks, docxConverter } from './converter.js';
export { nodeHandlers } from './nodes.js';
export type { BlockSpec, CellSpec, ParagraphSpec } from './blocks.js';
