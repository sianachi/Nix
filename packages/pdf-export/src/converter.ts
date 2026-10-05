import { PRINT_PALETTE } from '@nix/design-tokens/print';
import {
  createLossReport,
  visitProse,
  type ConvertRequest,
  type DocumentConverter,
  type ItemBundle,
  type LossNotice,
  type LossReport,
  type LossSink,
} from '@nix/export';
import { renderView } from '@nix/view-render';
import PdfPrinter from 'pdfmake';

import type { PdfNode } from './content.js';
import { FONT_FAMILY, loadFonts } from './fonts.js';
import { CONTENT_WIDTH, nodeHandlers } from './nodes.js';
import { sheetTable } from './sheet.js';
import { DEFAULT_STYLE, PAGE_MARGINS, STYLES, TABLE_LAYOUTS } from './styles.js';

/**
 * An item bundle, as a PDF.
 *
 * **Declared loss is stated before a byte is produced; observed loss is written into the file.**
 * The two exist because they are known at different times: response headers are sent before the
 * first node is visited, so what somebody is told before pressing Export can only be a property of
 * the format. What this particular document actually lost is discovered while drawing it, and by
 * then the only place left to say it is the file - which is the better place anyway, because the
 * file outlives the download and the person who opens it in a month is the one who needs to know.
 *
 * **Output streams; input does not.** pdfmake assembles a whole document definition before PDFKit
 * emits a byte, so the bundles are consumed in full first. The ceiling on that belongs to the
 * caller - `EXPORT_LIMITS` upstream and a byte cap in the service - and nobody should read the
 * async signature below as a promise of constant memory.
 */

const DECLARED_LOSS: readonly LossNotice[] = [
  {
    kind: 'comment-dropped',
    detail: 'Comment threads are not carried over.',
  },
  {
    kind: 'reference-flattened',
    detail: 'Links to other items in your workspace become plain text.',
  },
  {
    kind: 'image-not-embedded',
    detail: 'Images stored elsewhere are shown as a placeholder with their description.',
  },
  {
    kind: 'disclosure-expanded',
    detail: 'Collapsible sections are printed open.',
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
    detail: 'A canvas is left out, because a page cannot carry a drawing this export can redraw.',
  },
  {
    kind: 'views-as-image',
    detail:
      'A board, calendar or gallery is drawn as a picture: it shows what it showed, and cannot be sorted, grouped or clicked.',
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

export const pdfConverter: DocumentConverter = {
  format: 'pdf',
  mediaType: 'application/pdf',
  extension: 'pdf',

  declaredLoss: () => DECLARED_LOSS,

  convert(request: ConvertRequest): AsyncGenerator<Uint8Array> {
    return render(request);
  },
};

/**
 * The document definition, before it becomes bytes.
 *
 * **Exported so tests can assert on what the mapping decided.** A PDF's text lives in a compressed
 * content stream, so searching the output bytes for a sentence finds nothing whether the sentence
 * is there or not - a test written that way passes vacuously in both directions, which is worse
 * than no test. Structure is asserted here; the bytes get one end-to-end check that they are a PDF.
 */
export async function buildContent(
  request: ConvertRequest,
): Promise<{ readonly content: readonly PdfNode[]; readonly report: LossReport }> {
  const report = createLossReport();
  const content: PdfNode[] = [];
  let first = true;

  for await (const bundle of request.bundles) {
    content.push(...itemContent(bundle, report, first));
    first = false;
  }

  content.push(...appendix(report));

  return { content, report };
}

async function* render(request: ConvertRequest): AsyncGenerator<Uint8Array> {
  const { content } = await buildContent(request);

  const printer = new PdfPrinter({ [FONT_FAMILY]: await loadFonts() });

  const document = printer.createPdfKitDocument(
    {
      content,
      styles: STYLES,
      defaultStyle: DEFAULT_STYLE,
      pageSize: 'A4',
      pageMargins: PAGE_MARGINS,
      info: {
        title: request.branding.title,
        // The export's own timestamp, not the clock: a converter has no clock, so two exports of
        // unchanged content stay comparable.
        creationDate: request.branding.exportedAt,
      },
      footer: (page: number, pages: number) => ({
        text: `${String(page)} of ${String(pages)}`,
        alignment: 'center',
        style: 'footer',
        margin: [0, 20, 0, 0],
      }),
    },
    { tableLayouts: TABLE_LAYOUTS },
  );

  // PDFKit's document is a readable stream that only finishes once ended. Iterating it before the
  // end() below would wait forever.
  document.end();

  for await (const chunk of document) {
    yield chunk as Uint8Array;
  }
}

/**
 * The item's views, drawn.
 *
 * **Before the body, matching the interface.** An item that offers a board opens on the board and
 * its document is what sits under it, so a page that put the text first would reorder somebody's
 * document to suit the exporter.
 *
 * The drawing is placed at the text width so it lines up with everything around it; SVG scales, so
 * this costs no resolution.
 */
function drawViews(bundle: ItemBundle, loss: LossSink): readonly PdfNode[] {
  const views = bundle.views?.views ?? [];

  if (views.length === 0) {
    return [];
  }

  loss.note(
    'views-as-image',
    'A view is drawn as a picture, so it shows what it showed and cannot be sorted or clicked.',
  );

  if (bundle.viewRowsTruncated) {
    loss.note(
      'view-rows-truncated',
      'A view is drawn with the first of the things inside it, not all of them.',
    );
  }

  const blocks: PdfNode[] = [];

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

    blocks.push(
      { text: view.name, style: 'summary', margin: [0, 6, 0, 4] },
      { svg: drawn.svg, width: CONTENT_WIDTH, margin: [0, 0, 0, 10] },
    );
  }

  return blocks;
}

/** One item: its title, then its body in whichever shape it stores one. */
function itemContent(bundle: ItemBundle, report: LossReport, first: boolean): readonly PdfNode[] {
  const loss = report.for(bundle.id);
  const blocks: PdfNode[] = [];

  if (!first) {
    // Each item after the first starts a page. A subtree export is a set of documents, not one
    // long one, and running them together would lose where each began.
    blocks.push({ text: '', pageBreak: 'before' });
  }

  blocks.push({ text: bundle.title || 'Untitled', style: 'title' });

  blocks.push(...drawViews(bundle, loss));

  const body = bundle.body;

  if (body === null) {
    // Not a loss. An item nobody has opened has no body to lose, and saying otherwise would put a
    // claim in the report that the document does not support.
    return blocks;
  }

  if ('prosemirror' in body) {
    const drawn = visitProse(body.prosemirror, nodeHandlers, {
      itemId: bundle.id,
      report,
    });

    if (drawn !== null) {
      blocks.push(drawn);
    }

    return blocks;
  }

  if ('sheet' in body) {
    const table = sheetTable(body.sheet, loss);
    if (table !== null) {
      blocks.push(table);
    }

    return blocks;
  }

  loss.note(
    'body-not-rendered',
    'This item is a canvas. A page cannot carry a drawing this export could redraw, so it is left out.',
  );

  return blocks;
}

/**
 * The closing report: what did not come across, in the file itself.
 *
 * Omitted entirely when nothing was lost, rather than printed empty. A page saying "nothing was
 * lost" invites the reader to check, and the honest signal for a lossless run is silence.
 */
function appendix(report: LossReport): readonly PdfNode[] {
  if (report.isEmpty()) {
    return [];
  }

  return [
    { text: '', pageBreak: 'before' },
    { text: 'What did not come across', style: 'appendixTitle' },
    {
      text: 'This file is a reading copy. The workspace still holds everything below.',
      style: 'appendixItem',
    },
    {
      ul: report.entries().map((entry) => ({ text: entry.detail, style: 'appendixItem' })),
    },
  ];
}
