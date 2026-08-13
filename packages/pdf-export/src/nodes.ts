import { PRINT_PALETTE } from '@nix/design-tokens/print';
import {
  readBoolean,
  readNumber,
  readString,
  type NodeHandlers,
  type ProseNode,
  type VisitContext,
} from '@nix/export';

import type { PdfNode } from './content.js';

/**
 * Every block and mark, drawn.
 *
 * The handler map is mapped over the schema's node names, so this file does not compile until every
 * block says what it becomes. What each one becomes is a judgement, and the judgements that lose
 * something record it rather than quietly approximating.
 */

/** A rule of thumb for the page's text width in points, for the horizontal rule's canvas. */
const CONTENT_WIDTH = 483;

const HEADING_STYLES: Readonly<Record<number, string>> = { 1: 'h1', 2: 'h2', 3: 'h3' };

export const nodeHandlers: NodeHandlers<PdfNode> = {
  doc: (_node, _ctx, children) => ({ stack: children() }),

  paragraph: (_node, _ctx, children) => ({ text: children(), style: 'body' }),

  /**
   * A leaf, wearing its marks.
   *
   * Marks become fields on this node rather than nested wrappers, which is how pdfmake expresses
   * them - a run is bold *and* a link, not a link inside a bold.
   */
  text: (node, ctx) => textNode(node, ctx),

  hardBreak: () => ({ text: '\n' }),

  heading: (node, _ctx, children) => ({
    text: children(),
    style: HEADING_STYLES[readNumber(node.attrs, 'level') ?? 1] ?? 'h3',
  }),

  blockquote: (_node, _ctx, children) => ({
    table: { widths: ['*'], body: [[{ stack: children(), style: 'quote' }]] },
    layout: 'quoted',
    margin: [0, 2, 0, 9],
  }),

  /**
   * Code, on its own ground.
   *
   * No syntax highlighting, and no loss entry for its absence: the editor does not highlight either,
   * so a PDF that matches it has lost nothing. Claiming a loss that is not one would make the
   * report's other claims worth less.
   */
  codeBlock: (_node, _ctx, children) => ({
    table: {
      widths: ['*'],
      body: [[{ stack: children().map((line) => ({ ...line, style: 'code' })) }]],
    },
    layout: 'banded',
    margin: [0, 2, 0, 9],
  }),

  horizontalRule: () => ({
    canvas: [
      {
        type: 'line',
        x1: 0,
        y1: 0,
        x2: CONTENT_WIDTH,
        y2: 0,
        lineWidth: 0.5,
        lineColor: PRINT_PALETTE.divider,
      },
    ],
    margin: [0, 8, 0, 12],
  }),

  /**
   * A callout, with its tone spelled out.
   *
   * On screen the four tones are told apart by colour; the token sheet is mono, so on paper they
   * would all look alike. Naming the tone above the block carries more than the colour did, which
   * is why this is not recorded as a loss.
   */
  callout: (node, _ctx, children) => {
    const tone = readString(node.attrs, 'tone');

    return {
      table: {
        widths: ['*'],
        body: [
          [
            {
              stack:
                tone === null
                  ? children()
                  : [{ text: tone.toUpperCase(), style: 'eyebrow' }, ...children()],
            },
          ],
        ],
      },
      layout: 'banded',
      margin: [0, 2, 0, 9],
    };
  },

  /**
   * An image, as the space it would have taken and the words describing it.
   *
   * **The bytes are not fetched, and this is the trust boundary rather than a shortcut.** The media
   * service holds no network egress except object storage and Core's internal API, which is the
   * entire reason it is a separate service. An image whose `src` is an arbitrary URL is therefore
   * unreachable by design, and it stays that way; see ADR-0035.
   */
  image: (node, ctx) => {
    const alt = readString(node.attrs, 'alt');

    ctx.loss.note(
      'image-not-embedded',
      alt === null
        ? 'An image is shown as a placeholder, because this export cannot fetch the picture itself.'
        : `The image "${alt}" is shown as a placeholder, because this export cannot fetch the picture itself.`,
    );

    return {
      table: {
        widths: ['*'],
        body: [
          [
            {
              stack: [
                { text: 'Image', style: 'eyebrow' },
                { text: alt ?? 'No description was given.', style: 'quote' },
              ],
            },
          ],
        ],
      },
      layout: 'banded',
      margin: [0, 2, 0, 9],
    };
  },

  bulletList: (_node, _ctx, children) => ({ ul: children(), margin: [0, 0, 0, 8] }),

  orderedList: (node, _ctx, children) => ({
    ol: children(),
    start: readNumber(node.attrs, 'start') ?? 1,
    margin: [0, 0, 0, 8],
  }),

  listItem: (_node, _ctx, children) => stackOrSingle(children()),

  /** Markers are drawn by the items, so the list itself carries none. */
  taskList: (_node, _ctx, children) => ({ ul: children(), type: 'none', margin: [0, 0, 0, 8] }),

  /**
   * A task, marked in ASCII.
   *
   * `[x]` and `[ ]` rather than a symbol from a second font, and never an emoji - CLAUDE.md bans
   * those outright, and a box glyph Nunito Sans does not carry would render as a blank anyway.
   */
  taskItem: (node, _ctx, children) => {
    const marker = readBoolean(node.attrs, 'checked') ? '[x] ' : '[ ] ';
    const [first, ...rest] = children();

    return stackOrSingle([
      first === undefined
        ? { text: marker }
        : { text: [{ text: marker }, ...inlinesOf(first)], style: 'body' },
      ...rest,
    ]);
  },

  table: (_node, _ctx, children) => {
    const rows = children().map((row) => row.text as readonly PdfNode[] | undefined);
    const body = rows.filter((row): row is readonly PdfNode[] => row !== undefined);
    const columns = body[0]?.length ?? 1;

    return {
      table: {
        // Even shares. A column's stored `colwidth` is in screen pixels against a viewport this
        // page does not have, so honouring it would mis-size the table rather than match it.
        widths: Array.from({ length: columns }, () => '*'),
        headerRows: 1,
        body,
      },
      layout: 'grid',
      margin: [0, 4, 0, 10],
    };
  },

  // A row carries its cells in `text` so `table` above can lift them out as an array; pdfmake wants
  // a body of arrays rather than of nodes.
  tableRow: (_node, _ctx, children) => ({ text: children() }),

  tableHeader: (_node, _ctx, children) => ({ stack: children(), style: 'tableHeader' }),
  tableCell: (_node, _ctx, children) => ({ stack: children() }),

  /**
   * Side by side, which pdfmake draws natively. Open XML cannot, and says so on its own side.
   *
   * The shares are normalised here rather than in `column`, because a column cannot see its
   * siblings and a share is meaningless without them.
   */
  columnBlock: (_node, _ctx, children) => ({
    columns: shareWidths(children()),
    margin: [0, 0, 0, 8],
  }),

  /**
   * One column, carrying its share as a bare number for {@link shareWidths} to turn into a
   * percentage. A number left in `width` would mean fixed points to pdfmake, which is why nothing
   * outside a `columnBlock` ever sees one.
   */
  column: (node, _ctx, children) => ({
    ...stackOrSingle(children()),
    width: readNumber(node.attrs, 'width') ?? 1,
  }),

  /**
   * A disclosure, open.
   *
   * A page cannot collapse, so the content is always shown. That is a real difference from reading
   * the same document on screen - somebody may have folded a long aside away deliberately - so it
   * is recorded rather than assumed harmless.
   */
  details: (_node, ctx, children) => {
    ctx.loss.note(
      'disclosure-expanded',
      'A collapsible section is printed open, because a page cannot fold.',
    );

    return { stack: children(), margin: [0, 2, 0, 8] };
  },

  detailsSummary: (_node, _ctx, children) => ({ text: children(), style: 'summary' }),
  detailsContent: (_node, _ctx, children) => ({ stack: children() }),

  /**
   * A pointer to another item or a person, flattened to its label.
   *
   * A PDF could carry an internal link when the target is inside the same export, and that is the
   * obvious second pass. Flat first, so the loss is stated rather than half-implemented.
   */
  reference: (node, ctx) => {
    const label = readString(node.attrs, 'label') ?? 'Untitled';

    ctx.loss.note(
      'reference-flattened',
      `A link to "${label}" became plain text, because this file cannot point back into the workspace.`,
    );

    return { text: label, style: 'reference' };
  },
};

/** A text leaf with its marks resolved onto it. */
function textNode(node: ProseNode, ctx: VisitContext): PdfNode {
  let result: PdfNode = { text: node.text ?? '' };

  for (const mark of node.marks) {
    switch (mark.type) {
      case 'bold':
        result = { ...result, bold: true };
        break;
      case 'italic':
        result = { ...result, italics: true };
        break;
      case 'underline':
        result = { ...result, decoration: 'underline' };
        break;
      case 'strike':
        result = { ...result, decoration: 'lineThrough' };
        break;
      case 'code':
        result = { ...result, style: 'codeInline' };
        break;
      case 'highlight':
        result = { ...result, background: PRINT_PALETTE.highlight };
        break;
      case 'link': {
        const href = readString(mark.attrs, 'href');
        result = href === null ? result : { ...result, link: href, style: 'link' };
        break;
      }
      case 'textColor':
        result = { ...result, ...colorOf(mark.attrs) };
        break;
      case 'comment':
        // The text stays; the thread hanging off it has nowhere to go on a page.
        ctx.loss.note(
          'comment-dropped',
          'A comment thread was not carried over, because a page has nowhere to put one.',
        );
        break;
    }
  }

  return result;
}

/**
 * The two colour roles a `textColor` mark can set.
 *
 * A value this build does not know renders as the default rather than throwing, which is the rule
 * the editor already applies - an export that refused a document the editor draws happily would be
 * the drift `@nix/editor-schema` exists to prevent.
 */
function colorOf(attrs: Readonly<Record<string, unknown>>): Partial<PdfNode> {
  const ROLES: Readonly<Record<string, string>> = {
    accent: PRINT_PALETTE.accentText,
    muted: PRINT_PALETTE.muted,
    default: PRINT_PALETTE.ink,
  };

  const text = readString(attrs, 'text');
  const background = readString(attrs, 'background');

  return {
    ...(text === null ? {} : { color: ROLES[text] ?? PRINT_PALETTE.ink }),
    ...(background === null ? {} : { background: ROLES[background] ?? PRINT_PALETTE.surface }),
  };
}

/** The inline runs of a node, so a marker can be prepended without nesting a stack in a text. */
function inlinesOf(node: PdfNode): readonly PdfNode[] {
  const text: string | readonly PdfNode[] | undefined = node.text;

  if (typeof text === 'object') {
    return text;
  }

  return [node];
}

/**
 * Relative shares as percentages of the row.
 *
 * pdfmake's columns take `'*'`, `'auto'`, a percentage or a fixed width - **not** a weighted star
 * like `'2*'`, which is a table-width form and reaches the renderer as the unparseable number
 * `2*0000`. Percentages are the only form that expresses "twice as wide as its neighbour" here.
 */
function shareWidths(columns: readonly PdfNode[]): readonly PdfNode[] {
  const shares = columns.map((column) =>
    typeof column.width === 'number' && column.width > 0 ? column.width : 1,
  );

  const total = shares.reduce((sum, share) => sum + share, 0);

  return columns.map((column, index) => ({
    ...column,
    width: `${((100 * (shares[index] ?? 1)) / total).toFixed(4)}%`,
  }));
}

/** One child stays itself; several become a stack. Keeps the tree shallow enough to read. */
function stackOrSingle(children: readonly PdfNode[]): PdfNode {
  return children.length === 1 && children[0] !== undefined ? children[0] : { stack: children };
}
