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
import { renderView } from '@nix/view-render';
import { AlignmentType, Document, ImageRun, LevelFormat, Packer, TextRun } from 'docx';

import { paragraph, type BlockSpec } from './blocks.js';

/**
 * The text width of a Word page in points: US Letter less one-inch margins, which is what Word's
 * default template uses. A picture wider than this is scaled down by Word and reads smaller than it
 * should, so views are drawn to it rather than to the PDF's slightly narrower A4 measure.
 */
const CONTENT_WIDTH = 468;
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
    kind: 'views-as-image',
    detail:
      'A board, calendar or gallery becomes a picture: it shows what it showed, and cannot be sorted, grouped or edited.',
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
    blocks.push(...(await drawViews(bundle, report, request)));
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

/**
 * The item's views, as pictures.
 *
 * **A raster, and only if the host can make one.** Open XML embeds pictures as bytes, so a drawing
 * has to be rasterised - which needs a native library this package must not carry if it is to stay
 * sandboxable. The host supplies it; a host that cannot says so in the report rather than failing
 * the export, which is what makes the capability optional rather than a hidden requirement.
 *
 * The title paragraph is written by `itemBlocks`, so this runs before it and produces the views
 * that sit under it - matching the interface, where an item offering a board opens on the board.
 */
async function drawViews(
  bundle: ItemBundle,
  report: LossReport,
  request: ConvertRequest,
): Promise<readonly BlockSpec[]> {
  const views = bundle.views?.views ?? [];

  if (views.length === 0) {
    return [];
  }

  const loss = report.for(bundle.id);
  const rasterise = request.host?.rasterise;

  if (rasterise === undefined) {
    loss.note(
      'views-as-image',
      'A view could not be drawn into this file, because this export cannot turn a drawing into a picture.',
    );
    return [];
  }

  loss.note(
    'views-as-image',
    'A view is a picture here: it shows what it showed and cannot be sorted, grouped or edited.',
  );

  if (bundle.viewRowsTruncated) {
    loss.note(
      'view-rows-truncated',
      'A view is drawn with the first of the things inside it, not all of them.',
    );
  }

  const blocks: BlockSpec[] = [];

  for (const view of views) {
    const drawn = renderView({
      view,
      rows: bundle.viewRows,
      schema: bundle.schema,
      palette: PRINT_PALETTE,
      width: CONTENT_WIDTH,
    });

    for (const note of drawn.notes) {
      loss.note('views-as-image', note);
    }

    // Twice the point size, so the picture still reads when somebody zooms in on it. Word scales it
    // back down to the width below.
    const png = await rasterise(drawn.svg, Math.round(drawn.width * 2));
    const height = Math.round((drawn.height / drawn.width) * CONTENT_WIDTH);

    blocks.push(
      paragraph([new TextRun({ text: view.name, bold: true })], { spacingAfter: 60 }),
      paragraph(
        [
          new ImageRun({
            type: 'png',
            data: Buffer.from(png),
            transformation: { width: CONTENT_WIDTH, height },
          }),
        ],
        { spacingAfter: 160 },
      ),
    );
  }

  return blocks;
}

function itemBlocks(bundle: ItemBundle, report: LossReport): readonly BlockSpec[] {
  const loss = report.for(bundle.id);
  const blocks: BlockSpec[] = [
    paragraph([new TextRun({ text: bundle.title || 'Untitled', bold: true, size: 44 })], {
      spacingAfter: 240,
    }),
  ];

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
