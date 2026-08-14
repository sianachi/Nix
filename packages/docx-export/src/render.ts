import { PRINT_PALETTE } from '@nix/design-tokens/print';
import {
  BorderStyle,
  HeadingLevel,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  WidthType,
} from 'docx';

import type { BlockSpec, CellSpec, ParagraphSpec } from './blocks.js';
import { NUMBERING_REFERENCE, hex } from './nodes.js';

/**
 * The one place a description becomes Open XML.
 *
 * Every decoration a handler wanted is a field on the spec, so this reads as a translation rather
 * than as a second set of decisions. Nothing here consults the document; if a rule is not visible
 * on the spec it was not asked for.
 */

const HEADINGS = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
} as const;

export function renderBlocks(blocks: readonly BlockSpec[]): (Paragraph | Table)[] {
  return blocks.map((block) =>
    block.kind === 'paragraph' ? renderParagraph(block) : renderTable(block),
  );
}

function renderParagraph(spec: ParagraphSpec): Paragraph {
  return new Paragraph({
    children: [...spec.inlines],
    ...(spec.heading === undefined ? {} : { heading: HEADINGS[spec.heading] }),
    ...(spec.indentLeft === undefined ? {} : { indent: { left: spec.indentLeft } }),
    ...(spec.shading === undefined
      ? {}
      : {
          shading: {
            type: ShadingType.SOLID,
            color: hex(spec.shading),
            fill: hex(spec.shading),
          },
        }),
    ...borderOf(spec),
    ...listOf(spec),
    spacing: { after: spec.spacingAfter ?? 0 },
  });
}

function borderOf(spec: ParagraphSpec): Record<string, unknown> {
  if (spec.leftRule === undefined && spec.bottomRule === undefined) {
    return {};
  }

  return {
    border: {
      ...(spec.leftRule === undefined
        ? {}
        : { left: { style: BorderStyle.SINGLE, size: 12, color: hex(spec.leftRule) } }),
      ...(spec.bottomRule === undefined
        ? {}
        : { bottom: { style: BorderStyle.SINGLE, size: 6, color: hex(spec.bottomRule) } }),
    },
  };
}

function listOf(spec: ParagraphSpec): Record<string, unknown> {
  if (spec.list === undefined) {
    return {};
  }

  // Bullets use Word's own definition; numbers use the one this package declares, because an
  // ordered list has to restart per document rather than continue somebody else's count.
  return spec.list.kind === 'bullet'
    ? { bullet: { level: spec.list.level } }
    : { numbering: { reference: NUMBERING_REFERENCE, level: spec.list.level } };
}

function renderTable(spec: Extract<BlockSpec, { kind: 'table' }>): Table {
  return new Table({
    rows: spec.rows.map(
      (row, index) =>
        new TableRow({
          children: row.map((cell) => renderCell(cell)),
          tableHeader: spec.headerRow === true && index === 0,
        }),
    ),
    width: { size: 100, type: WidthType.PERCENTAGE },
    ...(spec.borderless === true ? { borders: NO_BORDERS } : {}),
  });
}

function renderCell(cell: CellSpec): TableCell {
  return new TableCell({
    children: renderBlocks(cell.blocks.length === 0 ? [emptyParagraph()] : cell.blocks),
    ...(cell.shading === undefined
      ? {}
      : {
          shading: {
            type: ShadingType.SOLID,
            color: hex(cell.shading),
            fill: hex(cell.shading),
          },
        }),
    ...(cell.widthPercent === undefined
      ? {}
      : { width: { size: cell.widthPercent, type: WidthType.PERCENTAGE } }),
  });
}

/**
 * A cell is never empty in Open XML.
 *
 * Word treats a table cell with no paragraph as a malformed document and refuses to open the file,
 * which is a worse failure than an empty-looking cell.
 */
function emptyParagraph(): ParagraphSpec {
  return { kind: 'paragraph', inlines: [] };
}

const BORDER_NONE = { style: BorderStyle.NONE, size: 0, color: hex(PRINT_PALETTE.surface) };

const NO_BORDERS = {
  top: BORDER_NONE,
  bottom: BORDER_NONE,
  left: BORDER_NONE,
  right: BORDER_NONE,
  insideHorizontal: BORDER_NONE,
  insideVertical: BORDER_NONE,
};
