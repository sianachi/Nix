import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

import {
  adjacentLine,
  edgeLine,
  lastCharacter,
  lineAt,
  lineText,
  nextGrapheme,
  previousGrapheme,
  type Line,
} from './text-motions';

/**
 * Vim's text objects, character finds, paragraph motions and search, as pure functions of the
 * document. Like the motions in `vim-motions.ts`, each works on text blocks as lines: a quote or
 * bracket pair is found within one block (a whole code block counts as one), and a paragraph is a
 * run of non-empty blocks between empty ones.
 */

export type Range =
  | { readonly linewise: false; readonly from: number; readonly to: number }
  | { readonly linewise: true; readonly first: Line; readonly last: Line };

const OBJECT_KEYS = [
  'w',
  '"',
  "'",
  '`',
  '(',
  ')',
  'b',
  '[',
  ']',
  '{',
  '}',
  'B',
  '<',
  '>',
  'p',
] as const;
type ObjectKey = (typeof OBJECT_KEYS)[number];
export type TextObject = `${'i' | 'a'}${ObjectKey}`;

export function isTextObject(keys: string): keys is TextObject {
  return (
    keys.length === 2 &&
    (keys.startsWith('i') || keys.startsWith('a')) &&
    (OBJECT_KEYS as readonly string[]).includes(keys.charAt(1))
  );
}

const BRACKETS: Readonly<Record<string, readonly [string, string]>> = {
  '(': ['(', ')'],
  ')': ['(', ')'],
  b: ['(', ')'],
  '[': ['[', ']'],
  ']': ['[', ']'],
  '{': ['{', '}'],
  '}': ['{', '}'],
  B: ['{', '}'],
  '<': ['<', '>'],
  '>': ['<', '>'],
};

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });

interface Run {
  readonly start: number;
  readonly end: number;
  readonly kind: 'word' | 'blank' | 'other';
}

/** The block as runs of word, blank and other characters: what `iw` takes as one word. */
function runs(line: Line): Run[] {
  const out: Run[] = [];
  for (const segment of wordSegmenter.segment(lineText(line))) {
    const kind =
      segment.isWordLike === true ? 'word' : /^\s+$/u.test(segment.segment) ? 'blank' : 'other';
    const end = segment.index + segment.segment.length;
    const last = out.at(-1);
    if (last?.kind === kind) out[out.length - 1] = { ...last, end };
    else out.push({ start: segment.index, end, kind });
  }
  return out;
}

function wordObject(line: Line, offset: number, around: boolean): [number, number] | null {
  const all = runs(line);
  const index = all.findIndex((run) => offset < run.end);
  const run = all[index];
  if (run === undefined) return null;
  if (!around) return [run.start, run.end];
  const next = all[index + 1];
  const previous = all[index - 1];
  if (run.kind === 'blank') return [run.start, next?.end ?? run.end];
  // `aw` takes the blanks after the word, or the ones before it when nothing follows.
  if (next?.kind === 'blank') return [run.start, next.end];
  if (previous?.kind === 'blank') return [previous.start, run.end];
  return [run.start, run.end];
}

/** Widens [from, to) by the blanks after it, or before it when there are none after. */
function withBlanks(text: string, from: number, to: number): [number, number] {
  let end = to;
  while (end < text.length && /[\t ]/.test(text.charAt(end))) end += 1;
  if (end > to) return [from, end];
  let start = from;
  while (start > 0 && /[\t ]/.test(text.charAt(start - 1))) start -= 1;
  return [start, to];
}

function quoteObject(
  line: Line,
  offset: number,
  quote: string,
  around: boolean,
): [number, number] | null {
  const text = lineText(line);
  const quotes: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charAt(index) === quote && text.charAt(index - 1) !== '\\') quotes.push(index);
  }
  // Quotes pair up from the start of the block, as in Vim; the first pair not behind the cursor wins.
  for (let index = 0; index + 1 < quotes.length; index += 2) {
    const open = quotes[index] ?? 0;
    const close = quotes[index + 1] ?? 0;
    if (close < offset) continue;
    return around ? withBlanks(text, open, close + 1) : [open + 1, close];
  }
  return null;
}

function bracketObject(
  line: Line,
  offset: number,
  [open, close]: readonly [string, string],
  around: boolean,
): [number, number] | null {
  const text = lineText(line);
  let depth = 0;
  let start = -1;
  for (let index = Math.min(offset, text.length - 1); index >= 0; index -= 1) {
    const char = text.charAt(index);
    if (char === close && index !== offset) depth += 1;
    else if (char === open) {
      if (depth === 0) {
        start = index;
        break;
      }
      depth -= 1;
    }
  }
  if (start === -1) return null;
  depth = 0;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (char === open) depth += 1;
    else if (char === close) {
      if (depth === 0) return around ? [start, index + 1] : [start + 1, index];
      depth -= 1;
    }
  }
  return null;
}

/** `ip` is the run of blocks that are all empty or all not; `ap` adds the next run of the other kind. */
function paragraphObject(
  doc: ProseMirrorNode,
  line: Line,
  around: boolean,
): { readonly first: Line; readonly last: Line } {
  const empty = line.size === 0;
  const extend = (from: Line, direction: 1 | -1, same: boolean): Line => {
    let edge = from;
    for (
      let next = adjacentLine(doc, edge, direction);
      next !== null && (next.size === 0) === (same ? empty : !empty);
      next = adjacentLine(doc, next, direction)
    ) {
      edge = next;
    }
    return edge;
  };
  const first = extend(line, -1, true);
  const last = extend(line, 1, true);
  if (!around) return { first, last };
  const after = extend(last, 1, false);
  return after.start !== last.start
    ? { first, last: after }
    : { first: extend(first, -1, false), last };
}

/** The range a text object covers around `pos`, or null when there is none (no enclosing pair). */
export function textObjectRange(
  doc: ProseMirrorNode,
  pos: number,
  object: TextObject,
): Range | null {
  const line = lineAt(doc, pos);
  if (line === null) return null;
  const around = object.startsWith('a');
  const key = object.charAt(1);
  if (key === 'p') return { linewise: true, ...paragraphObject(doc, line, around) };
  const offset = pos - line.start;
  const bracket = BRACKETS[key];
  const span =
    key === 'w'
      ? wordObject(line, offset, around)
      : bracket === undefined
        ? quoteObject(line, offset, key, around)
        : bracketObject(line, offset, bracket, around);
  return span === null
    ? null
    : { linewise: false, from: line.start + span[0], to: line.start + span[1] };
}

export type FindKey = 'f' | 't' | 'F' | 'T';

/**
 * Where `f`, `t`, `F` or `T` lands in the block, or null when the character is not there. `repeat`
 * is `;` or `,`: a repeated `t` starts one character on, so it never finds the one it stands before.
 */
export function findInLine(
  line: Line,
  offset: number,
  key: FindKey,
  char: string,
  count: number,
  repeat: boolean,
): number | null {
  const text = lineText(line);
  const forward = key === 'f' || key === 't';
  let at = repeat && key === 't' ? offset + 1 : repeat && key === 'T' ? offset - 1 : offset;
  for (let step = 0; step < count; step += 1) {
    if (!forward && at <= 0) return null;
    at = forward ? text.indexOf(char, at + 1) : text.lastIndexOf(char, at - 1);
    if (at === -1) return null;
  }
  if (key === 't') return previousGrapheme(line, at);
  if (key === 'T') return nextGrapheme(line, at);
  return at;
}

/**
 * `}` and `{`: the next or previous empty block past the current paragraph. With none left, the
 * motion stops at the document's edge, on its last character going down (`end: true`).
 */
export function paragraphTarget(
  doc: ProseMirrorNode,
  line: Line,
  direction: 1 | -1,
  count: number,
): { readonly line: Line; readonly offset: number; readonly end: boolean } {
  let current = line;
  for (let step = 0; step < count; step += 1) {
    let next = adjacentLine(doc, current, direction);
    while (next !== null && next.size === 0) {
      current = next;
      next = adjacentLine(doc, current, direction);
    }
    while (next !== null && next.size > 0) {
      current = next;
      next = adjacentLine(doc, current, direction);
    }
    if (next === null) {
      return direction === 1
        ? { line: current, offset: lastCharacter(current), end: true }
        : { line: current, offset: 0, end: false };
    }
    current = next;
  }
  return { line: current, offset: 0, end: false };
}

/**
 * A search pattern as a regular expression. It is JavaScript's syntax, matched case-insensitively
 * unless it has a capital letter (Vim's `smartcase`); a pattern that does not compile is literal.
 */
export function searchExpression(pattern: string, ignoreCase?: boolean): RegExp {
  const flags = (ignoreCase ?? !/\p{Lu}/u.test(pattern)) ? 'giu' : 'gu';
  try {
    return new RegExp(pattern, flags);
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  }
}

function matchStarts(line: Line, expression: RegExp): number[] {
  return Array.from(lineText(line).matchAll(expression), (match) => match.index);
}

/**
 * The start of the next (or previous) match after `from`, wrapping around the document once as
 * Vim's `wrapscan` does. Matches stay inside one block.
 */
export function searchFrom(
  doc: ProseMirrorNode,
  from: number,
  expression: RegExp,
  forward: boolean,
): { readonly pos: number; readonly wrapped: boolean } | null {
  const origin = lineAt(doc, from);
  if (origin === null) return null;
  const offset = from - origin.start;
  const direction = forward ? 1 : -1;
  const pick = (starts: number[], test: (start: number) => boolean): number | undefined =>
    forward ? starts.find(test) : starts.findLast(test);

  const first = pick(matchStarts(origin, expression), (start) =>
    forward ? start > offset : start < offset,
  );
  if (first !== undefined) return { pos: origin.start + first, wrapped: false };

  let line: Line = origin;
  let wrapped = false;
  for (;;) {
    let next = adjacentLine(doc, line, direction);
    if (next === null) {
      if (wrapped) return null;
      wrapped = true;
      next = edgeLine(doc, direction);
      if (next === null) return null;
    }
    if (wrapped && next.start === origin.start) {
      const back = pick(matchStarts(next, expression), (start) =>
        forward ? start <= offset : start >= offset,
      );
      return back === undefined ? null : { pos: next.start + back, wrapped };
    }
    const hit = pick(matchStarts(next, expression), () => true);
    if (hit !== undefined) return { pos: next.start + hit, wrapped };
    line = next;
  }
}
