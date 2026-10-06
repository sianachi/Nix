import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Selection } from '@tiptap/pm/state';

/**
 * Position arithmetic shared by the Vim and Emacs presets.
 *
 * Both presets move through a rich document by text block - a paragraph, a heading, a list item's
 * paragraph, a code block - because those are the document's lines. Inside a block, every
 * position is one string offset: a text node contributes its characters, and any other inline
 * node (a mention, an image, a hard break) contributes one U+FFFC per position it occupies, so an
 * atom is never mistaken for a word and offsets never drift from document positions.
 *
 * Character steps are whole Unicode graphemes, read from a small window around the offset rather
 * than the whole block, so `l` or Ctrl+F in a 100,000-character paragraph costs the same as in a
 * short one. Word motions do read the block: a word boundary can depend on what came before it.
 */

const OBJECT = '￼';
/** Longer than any grapheme a person types; a cluster beyond it is split, never corrupted. */
const GRAPHEME_WINDOW = 64;

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });

/** One text block, addressed by the document position where its content starts. */
export interface Line {
  readonly node: ProseMirrorNode;
  /** The document position of offset 0. */
  readonly start: number;
  /** The block's content size, which is also its largest offset. */
  readonly size: number;
}

/** The text block that contains `pos`, or null when `pos` is not inside one. */
export function lineAt(doc: ProseMirrorNode, pos: number): Line | null {
  const $pos = doc.resolve(Math.max(0, Math.min(doc.content.size, pos)));
  if (!$pos.parent.isTextblock) return null;
  return { node: $pos.parent, start: $pos.start(), size: $pos.parent.content.size };
}

/** The next (1) or previous (-1) text block, skipping anything that holds no text. */
export function adjacentLine(doc: ProseMirrorNode, line: Line, direction: 1 | -1): Line | null {
  const edge = direction === 1 ? line.start + line.size + 1 : line.start - 1;
  if (edge < 0 || edge > doc.content.size) return null;
  const found = Selection.findFrom(doc.resolve(edge), direction, true);
  if (found === null) return null;
  const next = lineAt(doc, found.head);
  return next === null || next.start === line.start ? null : next;
}

/** The first or last text block of the document. */
export function edgeLine(doc: ProseMirrorNode, direction: 1 | -1): Line | null {
  const found = Selection.findFrom(
    doc.resolve(direction === 1 ? 0 : doc.content.size),
    direction,
    true,
  );
  return found === null ? null : lineAt(doc, found.head);
}

/** The block's text from `from` to `to`, one character per position. */
export function lineText(line: Line, from = 0, to = line.size): string {
  let text = '';
  line.node.forEach((child, offset) => {
    const end = offset + child.nodeSize;
    if (end <= from || offset >= to) return;
    const piece = child.isText ? (child.text ?? '') : OBJECT.repeat(child.nodeSize);
    text += piece.slice(Math.max(0, from - offset), Math.min(piece.length, to - offset));
  });
  return text;
}

/** The offset after the grapheme that starts at (or contains) `offset`; `size` at the end. */
export function nextGrapheme(line: Line, offset: number): number {
  if (offset >= line.size) return line.size;
  const window = lineText(line, offset, Math.min(line.size, offset + GRAPHEME_WINDOW));
  const first = graphemeSegmenter.segment(window).containing(0);
  return offset + (first?.segment.length ?? 1);
}

/** The offset where the grapheme before `offset` starts; 0 at the start. */
export function previousGrapheme(line: Line, offset: number): number {
  if (offset <= 0) return 0;
  const from = Math.max(0, offset - GRAPHEME_WINDOW);
  const window = lineText(line, from, offset);
  const last = graphemeSegmenter.segment(window).containing(window.length - 1);
  return from + (last?.index ?? window.length - 1);
}

/** Where the block's last grapheme starts: the furthest a Vim Normal-mode cursor can sit. */
export function lastCharacter(line: Line): number {
  return line.size === 0 ? 0 : previousGrapheme(line, line.size);
}

/** The first offset that is not a space or tab, as Vim's `^` and `I` use it. */
export function firstNonBlank(line: Line): number {
  const text = lineText(line, 0, Math.min(line.size, 512));
  const match = /[^\t ]/u.exec(text);
  return match === null ? Math.min(text.length, line.size) : match.index;
}

/** The language words of a block, as [start, end) offsets. */
export function* words(line: Line): Generator<{ readonly start: number; readonly end: number }> {
  for (const segment of wordSegmenter.segment(lineText(line))) {
    if (segment.isWordLike === true) {
      yield { start: segment.index, end: segment.index + segment.segment.length };
    }
  }
}

/** The start of the first word that begins after `offset` in this block, if any. */
export function nextWordStart(line: Line, offset: number): number | null {
  for (const word of words(line)) {
    if (word.start > offset) return word.start;
  }
  return null;
}

/** The start of the last word that begins before `offset` in this block, if any. */
export function previousWordStart(line: Line, offset: number): number | null {
  let found: number | null = null;
  for (const word of words(line)) {
    if (word.start >= offset) break;
    found = word.start;
  }
  return found;
}

/** The end of the first word that ends after `offset` in this block, if any. */
export function nextWordEnd(line: Line, offset: number): number | null {
  for (const word of words(line)) {
    if (word.end > offset) return word.end;
  }
  return null;
}
