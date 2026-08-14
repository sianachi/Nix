import { PRINT_PALETTE } from '@nix/design-tokens/print';
import {
  readBoolean,
  readNumber,
  readString,
  type NodeHandlers,
  type ProseNode,
  type VisitContext,
} from '@nix/export';
import { ExternalHyperlink, ShadingType, TextRun, type ParagraphChild } from 'docx';

import { decorate, paragraph, type BlockSpec, type CellSpec } from './blocks.js';

/**
 * Every block and mark, as Open XML.
 *
 * **Flat where the PDF mapper was a tree.** A Word document is a sequence of paragraphs and tables;
 * nesting is a reference to a numbering definition and a level, not containment. That is why this
 * file shares only the dispatcher with the PDF mapper and none of its emitters - a common target
 * model would be a shape neither format has, and it would make the one loss that is real here and
 * not there, `columns-as-table`, impossible to state.
 *
 * A handler returns a list rather than a single node, because one block often becomes several
 * paragraphs: a code block becomes one per line, since an Open XML run cannot hold a newline.
 */

/** What a handler produces. Exactly one field is ever set. */
export interface DocxContent {
  readonly blocks?: readonly BlockSpec[];
  readonly inlines?: readonly ParagraphChild[];

  /** Set by a row or a cell so the table above can lift them out. */
  readonly cells?: readonly CellSpec[];
}

export const NUMBERING_REFERENCE = 'nix-ordered';

/** Open XML numbering definitions carry nine levels; past that a list has to flatten. */
export const MAX_LIST_LEVEL = 8;

/** Open XML colours carry no leading hash. */
export const hex = (colour: string): string => colour.replace('#', '');

const BODY_SPACING = 140;

export const nodeHandlers: NodeHandlers<DocxContent> = {
  doc: (_node, _ctx, children) => ({ blocks: blocksOf(children()) }),

  paragraph: (_node, _ctx, children) => ({
    blocks: [paragraph(inlinesOf(children()), { spacingAfter: BODY_SPACING })],
  }),

  text: (node, ctx) => ({ inlines: [textRun(node, ctx)] }),

  hardBreak: () => ({ inlines: [new TextRun({ break: 1 })] }),

  heading: (node, _ctx, children) => ({
    blocks: [
      paragraph(inlinesOf(children()), { heading: headingLevel(readNumber(node.attrs, 'level')) }),
    ],
  }),

  /**
   * A quotation, marked by a rule and an indent rather than by a named style.
   *
   * Word's built-in `Quote` style is in its default template but not in every template a document
   * might be opened against, and a style reference that resolves to nothing renders as ordinary body
   * text with no sign anything was meant.
   */
  blockquote: (_node, _ctx, children) => ({
    blocks: decorate(blocksOf(children()), {
      indentLeft: 360,
      leftRule: PRINT_PALETTE.divider,
    }),
  }),

  /**
   * Code, one paragraph per line.
   *
   * An Open XML run cannot hold a line break inside literal text, so a multi-line listing has to
   * become several paragraphs. No syntax highlighting, and no loss recorded for its absence: the
   * editor does not highlight either, so nothing was lost.
   */
  codeBlock: (_node, _ctx, children) => ({
    blocks: textOf(inlinesOf(children()))
      .split('\n')
      .map((line) =>
        paragraph([new TextRun({ text: line, font: 'Consolas', size: 19 })], {
          monospace: true,
          shading: PRINT_PALETTE.codeFill,
          spacingAfter: 0,
        }),
      ),
  }),

  horizontalRule: () => ({
    blocks: [paragraph([], { bottomRule: PRINT_PALETTE.divider, spacingAfter: 160 })],
  }),

  /** A callout: a shaded box with its tone named above the text, matching the PDF's decision. */
  callout: (node, _ctx, children) => {
    const tone = readString(node.attrs, 'tone');

    return {
      blocks: [
        box(
          [...(tone === null ? [] : [eyebrow(tone.toUpperCase())]), ...blocksOf(children())],
          PRINT_PALETTE.calloutFill,
        ),
      ],
    };
  },

  /**
   * An image, as the space it would have taken and the words describing it.
   *
   * The bytes are not fetched, and that is the trust boundary rather than a shortcut: the media
   * service holds no egress except object storage and Core's internal API. See ADR-0035.
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
      blocks: [
        box(
          [
            eyebrow('IMAGE'),
            paragraph([
              new TextRun({
                text: alt ?? 'No description was given.',
                italics: true,
                color: hex(PRINT_PALETTE.muted),
              }),
            ]),
          ],
          PRINT_PALETTE.surface,
        ),
      ],
    };
  },

  bulletList: (_node, ctx, children) => ({ blocks: listed(children(), ctx, 'bullet') }),
  orderedList: (_node, ctx, children) => ({ blocks: listed(children(), ctx, 'number') }),

  listItem: (_node, _ctx, children) => ({ blocks: blocksOf(children()) }),

  /** Markers are written into the text, so the list carries none of Word's own. */
  taskList: (_node, _ctx, children) => ({ blocks: blocksOf(children()) }),

  /**
   * A task, marked in ASCII.
   *
   * `[x]` and `[ ]` rather than a symbol from a second font, and never an emoji - CLAUDE.md bans
   * those, and a box glyph the document's typeface lacks renders as a blank anyway.
   */
  taskItem: (node, _ctx, children) => {
    const marker = readBoolean(node.attrs, 'checked') ? '[x] ' : '[ ] ';
    const blocks = blocksOf(children());
    const [first, ...rest] = blocks;

    if (first?.kind !== 'paragraph') {
      return { blocks: [paragraph([new TextRun({ text: marker })]), ...blocks] };
    }

    // Prepended to the existing inlines rather than to a rebuilt paragraph, so the item's own text
    // survives - which is the whole reason paragraphs are described before they are constructed.
    return {
      blocks: [
        { ...first, inlines: [new TextRun({ text: marker }), ...first.inlines], indentLeft: 360 },
        ...rest,
      ],
    };
  },

  table: (_node, _ctx, children) => {
    const rows = children()
      .map((row) => row.cells)
      .filter((cells): cells is readonly CellSpec[] => cells !== undefined && cells.length > 0);

    return {
      blocks: rows.length === 0 ? [] : [{ kind: 'table', rows, headerRow: true }],
    };
  },

  tableRow: (_node, _ctx, children) => ({ cells: children().flatMap((cell) => cell.cells ?? []) }),

  tableHeader: (_node, _ctx, children) => ({
    cells: [{ blocks: blocksOf(children()), shading: PRINT_PALETTE.surface }],
  }),

  tableCell: (_node, _ctx, children) => ({ cells: [{ blocks: blocksOf(children()) }] }),

  /**
   * Columns, as a borderless table.
   *
   * **The one place the two formats genuinely differ.** Open XML has section-level columns, which
   * reflow a whole page, and no inline multi-column region at all. A borderless one-row table puts
   * the content side by side without pretending to be what the editor drew, so the difference is
   * recorded rather than passed off as equivalent.
   */
  columnBlock: (_node, ctx, children) => {
    ctx.loss.note(
      'columns-as-table',
      'Side-by-side columns became a borderless table, because Word has no inline column region.',
    );

    const cells = children().flatMap((column) => column.cells ?? []);

    return {
      blocks: cells.length === 0 ? [] : [{ kind: 'table', rows: [cells], borderless: true }],
    };
  },

  column: (node, _ctx, children) => {
    const width = share(readNumber(node.attrs, 'width'));

    return {
      cells: [{ blocks: blocksOf(children()), ...(width === null ? {} : { widthPercent: width }) }],
    };
  },

  details: (_node, ctx, children) => {
    ctx.loss.note(
      'disclosure-expanded',
      'A collapsible section is written out open, because a Word document cannot fold.',
    );

    return { blocks: blocksOf(children()) };
  },

  detailsSummary: (_node, _ctx, children) => ({
    blocks: [
      paragraph(
        inlinesOf(children()).map((run) => bolden(run)),
        { spacingAfter: 60 },
      ),
    ],
  }),

  detailsContent: (_node, _ctx, children) => ({ blocks: blocksOf(children()) }),

  reference: (node, ctx) => {
    const label = readString(node.attrs, 'label') ?? 'Untitled';

    ctx.loss.note(
      'reference-flattened',
      `A link to "${label}" became plain text, because this file cannot point back into the workspace.`,
    );

    return { inlines: [new TextRun({ text: label, color: hex(PRINT_PALETTE.accentText) })] };
  },
};

function headingLevel(level: number | null): 1 | 2 | 3 {
  return level === 1 || level === 2 || level === 3 ? level : 3;
}

/**
 * A column's share of the row, as a percentage, or null to let Word divide the row equally.
 *
 * The stored width is a relative factor against its siblings, which a cell cannot see - so this
 * approximates against a nominal three-column row rather than normalising. A column that says
 * nothing gets no width at all, which is the case that matters and the one Word handles best.
 */
function share(width: number | null): number | null {
  return width === null ? null : Math.min(100, Math.max(1, Math.round(width * 33)));
}

function eyebrow(text: string): BlockSpec {
  return paragraph([new TextRun({ text, bold: true, size: 16, color: hex(PRINT_PALETTE.muted) })], {
    spacingAfter: 60,
  });
}

function box(blocks: readonly BlockSpec[], fill: string): BlockSpec {
  return { kind: 'table', rows: [[{ blocks, shading: fill }]], borderless: true };
}

/**
 * List items, at the level the walk reached them.
 *
 * The walk counts a list and its items as two levels where Open XML counts one, so the depth is
 * halved. Past the ninth level the numbering definition has nothing left to say, so the item
 * flattens to the deepest level and the report says so.
 */
function listed(
  items: readonly DocxContent[],
  ctx: VisitContext,
  kind: 'bullet' | 'number',
): readonly BlockSpec[] {
  const wanted = Math.floor(ctx.depth / 2);
  const level = Math.min(wanted, MAX_LIST_LEVEL);

  if (wanted > MAX_LIST_LEVEL) {
    ctx.loss.note(
      'list-depth',
      `A list nested deeper than ${String(MAX_LIST_LEVEL + 1)} levels is flattened to the deepest level Word numbers.`,
    );
  }

  // Only paragraphs that are not already list items: a nested list decorates its own items on the
  // way up, and the outer list must not overwrite them with its shallower level. Without this every
  // item in a nested list numbers at level 0 and the nesting disappears.
  return blocksOf(items).map((block) =>
    block.kind === 'paragraph' && block.list === undefined
      ? { ...block, list: { kind, level }, spacingAfter: 60 }
      : block,
  );
}

/** A text leaf with its marks resolved onto the run. */
function textRun(node: ProseNode, ctx: VisitContext): ParagraphChild {
  const text = node.text ?? '';

  let options: ConstructorParameters<typeof TextRun>[0] = { text };
  let href: string | null = null;

  for (const mark of node.marks) {
    switch (mark.type) {
      case 'bold':
        options = { ...options, bold: true };
        break;
      case 'italic':
        options = { ...options, italics: true };
        break;
      case 'underline':
        options = { ...options, underline: {} };
        break;
      case 'strike':
        options = { ...options, strike: true };
        break;
      case 'code':
        options = { ...options, font: 'Consolas', ...shade(PRINT_PALETTE.codeFill) };
        break;
      case 'highlight':
        options = { ...options, ...shade(PRINT_PALETTE.highlight) };
        break;
      case 'link':
        href = readString(mark.attrs, 'href');
        break;
      case 'textColor':
        options = { ...options, ...colourOf(mark.attrs) };
        break;
      case 'comment':
        ctx.loss.note(
          'comment-dropped',
          'A comment thread was not carried over, because this file has nowhere to put one.',
        );
        break;
    }
  }

  if (href !== null) {
    return new ExternalHyperlink({
      children: [new TextRun({ ...options, style: 'Hyperlink' })],
      link: href,
    });
  }

  return new TextRun(options);
}

function colourOf(attrs: Readonly<Record<string, unknown>>): { color?: string } {
  const ROLES: Readonly<Record<string, string>> = {
    accent: PRINT_PALETTE.accentText,
    muted: PRINT_PALETTE.muted,
    default: PRINT_PALETTE.ink,
  };

  const text = readString(attrs, 'text');

  // An unknown value renders as the default rather than throwing, which is the rule the editor
  // applies. An export that refused a document the editor draws happily would be the drift the
  // shared schema exists to prevent.
  return text === null ? {} : { color: hex(ROLES[text] ?? PRINT_PALETTE.ink) };
}

function shade(colour: string): {
  shading: { type: (typeof ShadingType)[keyof typeof ShadingType]; color: string; fill: string };
} {
  return { shading: { type: ShadingType.SOLID, color: hex(colour), fill: hex(colour) } };
}

/**
 * The same run, bold.
 *
 * A summary's text arrives already built as runs, and `docx` exposes nothing to read one back, so a
 * run that is not a plain `TextRun` - a hyperlink, say - is passed through unchanged rather than
 * reconstructed into something lesser.
 */
function bolden(run: ParagraphChild): ParagraphChild {
  const text = literalText(run);
  return text === null ? run : new TextRun({ text, bold: true });
}

function blocksOf(children: readonly DocxContent[]): readonly BlockSpec[] {
  return children.flatMap((child) => child.blocks ?? []);
}

function inlinesOf(children: readonly DocxContent[]): readonly ParagraphChild[] {
  return children.flatMap((child) => child.inlines ?? []);
}

function textOf(runs: readonly ParagraphChild[]): string {
  return runs.map((run) => literalText(run) ?? '').join('');
}

/**
 * The literal characters of a run, or null when it is not a plain text run.
 *
 * `docx` keeps a run's options private, so this reads them through one narrow, checked accessor
 * rather than through a cast at each of the three call sites that need it. If a future `docx`
 * changes the field, this returns null and the two callers degrade to passing the run through
 * unchanged - which is why they are written to accept null rather than to assume a string.
 */
function literalText(run: ParagraphChild): string | null {
  if (!(run instanceof TextRun)) {
    return null;
  }

  const options: unknown = (run as unknown as { options?: unknown }).options;

  if (typeof options === 'object' && options !== null) {
    const text: unknown = (options as { text?: unknown }).text;
    if (typeof text === 'string') {
      return text;
    }
  }

  return null;
}
