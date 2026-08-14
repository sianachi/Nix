import { PRINT_PALETTE } from '@nix/design-tokens/print';
import {
  createLossReport,
  visitProse,
  type ConvertRequest,
  type DocumentConverter,
  type ItemBundle,
  type LossNotice,
  type LossReport,
} from '@nix/export';
import { AlignmentType, Document, LevelFormat, Packer, TextRun } from 'docx';

import { paragraph, type BlockSpec } from './blocks.js';
import { MAX_LIST_LEVEL, NUMBERING_REFERENCE, hex, nodeHandlers } from './nodes.js';
import { renderBlocks } from './render.js';
import { sheetTable } from './sheet.js';

/**
 * An item bundle, as a Word document.
 *
 * **A Word document is for editing elsewhere, which is a different promise from a PDF's.** Somebody
 * exporting to DOCX intends to keep working on the text in another tool, so the mapping favours
 * structure that survives editing - real headings, real lists, real tables - over a faithful picture
 * of the page. Where Open XML has no equivalent at all, the difference is recorded rather than
 * approximated silently.
 *
 * The two loss surfaces work as they do for every format: what the format cannot carry is declared
 * before the export runs, and what this document actually lost is written into the file's last
 * section, because the file outlives the download.
 */

const DECLARED_LOSS: readonly LossNotice[] = [
  { kind: 'comment-dropped', detail: 'Comment threads are not carried over.' },
  {
    kind: 'reference-flattened',
    detail: 'Links to other items in your workspace become plain text.',
  },
  {
    kind: 'image-not-embedded',
    detail: 'Images stored elsewhere are shown as a placeholder with their description.',
  },
  { kind: 'disclosure-expanded', detail: 'Collapsible sections are written out open.' },
  {
    kind: 'columns-as-table',
    detail:
      'Side-by-side columns become a borderless table, which Word can edit but will not reflow the same way.',
  },
  {
    kind: 'list-depth',
    detail:
      'Lists nested more than nine levels deep are flattened to the deepest level Word numbers.',
  },
  {
    kind: 'formula-flattened',
    detail: 'A spreadsheet shows the values it worked out, not the formulas behind them.',
  },
  {
    kind: 'sheet-truncated',
    detail: 'A spreadsheet wider or longer than the page carries is cut off at the edge.',
  },
  {
    kind: 'body-not-rendered',
    detail:
      'A canvas is left out, because a Word document cannot carry a drawing this export can redraw.',
  },
  {
    kind: 'views-dropped',
    detail: 'The boards, calendars and tables an item shows its children through are not included.',
  },
  {
    kind: 'malformed-node',
    detail: 'Anything in the document this version cannot read is left out and listed at the end.',
  },
  {
    kind: 'unknown-node',
    detail: 'Blocks written by a newer version of Nix are left out and listed at the end.',
  },
  {
    kind: 'unknown-mark',
    detail: 'Text formatting from a newer version of Nix is dropped, and the text kept.',
  },
];

export const docxConverter: DocumentConverter = {
  format: 'docx',
  mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  extension: 'docx',

  declaredLoss: () => DECLARED_LOSS,

  convert(request: ConvertRequest): AsyncGenerator<Uint8Array> {
    return render(request);
  },
};

/**
 * The document's blocks, before they become a file.
 *
 * Exported for the same reason the PDF converter exports its own: a DOCX is a zip, so asserting on
 * output bytes tests the compressor rather than the mapping.
 */
export async function buildBlocks(
  request: ConvertRequest,
): Promise<{ readonly blocks: readonly BlockSpec[]; readonly report: LossReport }> {
  const report = createLossReport();
  const blocks: BlockSpec[] = [];

  for await (const bundle of request.bundles) {
    blocks.push(...itemBlocks(bundle, report));
  }

  blocks.push(...appendix(report));

  return { blocks, report };
}

async function* render(request: ConvertRequest): AsyncGenerator<Uint8Array> {
  const { blocks } = await buildBlocks(request);

  const document = new Document({
    title: request.branding.title,
    creator: 'Nix',
    // `docx` exposes no created/modified fields, so the file's own timestamps come from the clock
    // inside the library rather than from `branding.exportedAt`. Two exports of unchanged content
    // are therefore not byte-identical, which `.nix` guarantees and this format does not - stated
    // here so nobody infers the guarantee from the shared seam.
    styles: { default: { document: { run: { font: 'Nunito Sans', size: 21 } } } },
    numbering: {
      config: [
        {
          reference: NUMBERING_REFERENCE,
          levels: Array.from({ length: MAX_LIST_LEVEL + 1 }, (_unused, level) => ({
            level,
            format: LevelFormat.DECIMAL,
            text: `%${String(level + 1)}.`,
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 360 * (level + 1), hanging: 260 } } },
          })),
        },
      ],
    },
    sections: [{ children: renderBlocks(blocks) }],
  });

  // Packer produces the whole zip before yielding: a DOCX's central directory means there is no
  // honest way to stream one out, unlike the .nix archive, which is written entry by entry.
  yield await Packer.toBuffer(document);
}

function itemBlocks(bundle: ItemBundle, report: LossReport): readonly BlockSpec[] {
  const loss = report.for(bundle.id);
  const blocks: BlockSpec[] = [
    paragraph([new TextRun({ text: bundle.title || 'Untitled', bold: true, size: 44 })], {
      spacingAfter: 240,
    }),
  ];

  if (bundle.views?.views.length !== undefined && bundle.views.views.length > 0) {
    loss.note(
      'views-dropped',
      'The views this item shows its children through are not part of the document.',
    );
  }

  const body = bundle.body;

  if (body === null) {
    // Not a loss. An item nobody has opened has no body to lose.
    return blocks;
  }

  if ('prosemirror' in body) {
    const drawn = visitProse(body.prosemirror, nodeHandlers, {
      itemId: bundle.id,
      report,
    });

    return [...blocks, ...(drawn?.blocks ?? [])];
  }

  if ('sheet' in body) {
    const table = sheetTable(body.sheet, loss);
    return table === null ? blocks : [...blocks, table];
  }

  loss.note(
    'body-not-rendered',
    'This item is a canvas. A Word document cannot carry a drawing this export could redraw, so it is left out.',
  );

  return blocks;
}

/**
 * The closing report, in the file itself.
 *
 * Omitted entirely when nothing was lost. A section saying "nothing was lost" invites the reader to
 * go and check; the honest signal for a clean run is silence.
 */
function appendix(report: LossReport): readonly BlockSpec[] {
  if (report.isEmpty()) {
    return [];
  }

  return [
    paragraph([new TextRun({ text: 'What did not come across', bold: true, size: 28 })], {
      spacingAfter: 160,
    }),
    paragraph(
      [
        new TextRun({
          text: 'This file is an editing copy. The workspace still holds everything below.',
          color: hex(PRINT_PALETTE.muted),
        }),
      ],
      { spacingAfter: 160 },
    ),
    ...report.entries().map((entry) =>
      paragraph([new TextRun({ text: entry.detail, color: hex(PRINT_PALETTE.muted) })], {
        list: { kind: 'bullet', level: 0 },
        spacingAfter: 60,
      }),
    ),
  ];
}
