import { Extension, type Editor } from '@tiptap/core';
import { GapCursor } from '@tiptap/pm/gapcursor';
import type { Node as ProseMirrorNode, Slice } from '@tiptap/pm/model';
import {
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { redo, undo, ySyncPluginKey } from 'y-prosemirror';

import {
  adjacentLine,
  edgeLine,
  firstNonBlank,
  lastCharacter,
  lineAt,
  nextGrapheme,
  nextWordStart,
  previousGrapheme,
  previousWordStart,
  words,
  type Line,
} from './text-motions';

/**
 * Vim basics: a bounded modal preset over a rich, collaborative document.
 *
 * **The cursor sits on a character.** In Normal and Visual mode the caret position `p` means "the
 * character that starts at `p`", drawn as a block. So it never rests after a block's last
 * character, `e` and `$` land on the last character of a word or block, `a` appends after the
 * character under the cursor, and Escape from Insert steps back one character - each as in Vim.
 *
 * **Lines are text blocks.** `j`/`k` move between paragraphs, headings, list items and code
 * blocks, keeping the column; `w`/`b`/`e` continue into the next or previous block; `dd`, `yy`,
 * `cc` and Visual Line take whole blocks. Arrow keys keep their native, visual-line behaviour.
 *
 * **Commands** follow Vim's grammar: `[count] operator [count] motion`, a doubled operator for a
 * whole line, or a single action. Typed keys accumulate in `pending` until they form one.
 *
 * **One register**, shared by every editor on the page like Vim's unnamed register. It holds a
 * ProseMirror slice, so a yanked heading, link or mention pastes back as itself.
 *
 * **Undo** is the collaborative, client-local history the toolbar and Mod+Z use, so `u` never
 * undoes a colleague's edit. Mode changes and cursor moves are kept out of it.
 *
 * What is deliberately absent - `.`, registers by name, text objects, search, marks, macros and
 * `:` commands - is disclosed in Settings, next to the keys that are here.
 */

export type VimMode = 'normal' | 'insert' | 'visual' | 'visual-line';

interface VimMotionState {
  readonly enabled: boolean;
  readonly mode: VimMode;
  /** Keys typed toward a command that is not complete yet: a count, an operator, a `g`. */
  readonly pending: string;
  /** Visual mode's fixed end and moving cursor, mapped through every edit. */
  readonly anchor: number | null;
  readonly head: number | null;
}

type VimMotionMeta = Partial<VimMotionState>;

interface VimMotionsOptions {
  readonly isApplePlatform: boolean;
}

export const vimMotionsKey = new PluginKey<VimMotionState>('nixVimMotions');

const navigatorPlatform: unknown = Reflect.get(navigator, 'platform');
const defaultIsApplePlatform =
  typeof navigatorPlatform === 'string' && /Mac|iP(hone|[oa]d)/.test(navigatorPlatform);

/** Larger counts are almost always a slip, and each step is a real document walk. */
const MAX_COUNT = 9999;

const INITIAL: VimMotionState = {
  enabled: false,
  mode: 'insert',
  pending: '',
  anchor: null,
  head: null,
};

let register: { readonly slice: Slice; readonly linewise: boolean } | null = null;

function current(state: EditorState): VimMotionState {
  return vimMotionsKey.getState(state) ?? INITIAL;
}

function isVisual(mode: VimMode): boolean {
  return mode === 'visual' || mode === 'visual-line';
}

/** Mode and cursor bookkeeping never belongs in the undo history. */
function dispatch(view: EditorView, meta: VimMotionMeta, selection?: Selection): void {
  let transaction = view.state.tr.setMeta(vimMotionsKey, meta).setMeta('addToHistory', false);
  if (selection !== undefined && !selection.eq(view.state.selection)) {
    transaction = transaction.setSelection(selection).scrollIntoView();
  }
  view.dispatch(transaction);
}

function inTextControl(event: Event): boolean {
  const target = event.target;
  if (!(target instanceof Element)) {
    return true;
  }
  return (
    target.closest(
      'button, input, textarea, select, [contenteditable="false"], [role="separator"]',
    ) === null
  );
}

function isLegacyCompositionKey(event: KeyboardEvent): boolean {
  const keyCode: unknown = Reflect.get(event, 'keyCode');
  return keyCode === 229;
}

// ---------------------------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------------------------

/** A text position for the selection's head, finding the nearest text block for a rich selection. */
function textHead(state: EditorState): number | null {
  const { selection } = state;
  if (selection instanceof TextSelection) {
    return selection.head;
  }
  const found =
    Selection.findFrom(selection.$head, 1, true) ?? Selection.findFrom(selection.$head, -1, true);
  return found instanceof TextSelection ? found.head : null;
}

/** Where the Normal-mode block cursor is: the head, kept on a character. */
function normalCursor(state: EditorState): number | null {
  const head = textHead(state);
  if (head === null) return null;
  const line = lineAt(state.doc, head);
  if (line === null) return null;
  return line.start + Math.min(head - line.start, lastCharacter(line));
}

function caretAt(doc: ProseMirrorNode, pos: number): TextSelection {
  return TextSelection.create(doc, pos);
}

/** The caret Insert mode starts from when there is no text caret: a gap cursor at the end. */
function insertFallback(state: EditorState): Selection | null {
  const head = textHead(state);
  if (head !== null) return caretAt(state.doc, head);
  return state.doc.childCount === 0
    ? null
    : new GapCursor(state.doc.resolve(state.doc.content.size));
}

function nthLine(doc: ProseMirrorNode, n: number): Line | null {
  let seen = 0;
  let found: Line | null = null;
  doc.descendants((node, pos) => {
    if (found !== null && seen >= n) return false;
    if (!node.isTextblock) return true;
    seen += 1;
    found = { node, start: pos + 1, size: node.content.size };
    return false;
  });
  return found;
}

function firstWordOrStart(line: Line): number {
  return line.size === 0 ? 0 : (nextWordStart(line, -1) ?? 0);
}

function lastWordOrStart(line: Line): number {
  return line.size === 0 ? 0 : (previousWordStart(line, line.size + 1) ?? 0);
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

type Motion = 'h' | 'l' | 'j' | 'k' | 'w' | 'b' | 'e' | '0' | '^' | '$' | 'gg' | 'G';
type Operator = 'd' | 'c' | 'y';
type Action = 'i' | 'a' | 'I' | 'A' | 'o' | 'O' | 'p' | 'P' | 'u' | 'v' | 'V';

type Command =
  | { readonly kind: 'motion'; readonly motion: Motion; readonly count: number | null }
  | {
      readonly kind: 'operator';
      readonly operator: Operator;
      readonly motion: Motion;
      readonly count: number | null;
    }
  | { readonly kind: 'line-operator'; readonly operator: Operator; readonly count: number }
  | { readonly kind: 'visual-operator'; readonly operator: Operator }
  | { readonly kind: 'action'; readonly action: Action; readonly count: number };

type Parsed = Command | 'incomplete' | 'invalid';

const MOTIONS = new Set<string>(['h', 'l', 'j', 'k', 'w', 'b', 'e', '0', '^', '$', 'G']);
const ACTIONS = new Set<string>(['i', 'a', 'I', 'A', 'o', 'O', 'p', 'P', 'u', 'v', 'V']);
/** Shorthands Vim defines in terms of an operator and a motion. */
const SHORTHANDS: Readonly<Record<string, readonly [Operator, Motion]>> = {
  x: ['d', 'l'],
  X: ['d', 'h'],
  D: ['d', '$'],
  C: ['c', '$'],
};

function multiply(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return Math.min(MAX_COUNT, (a ?? 1) * (b ?? 1));
}

/** Reads Vim's command grammar from the keys typed so far. */
function parse(keys: string, visual: boolean): Parsed {
  let i = 0;
  const readCount = (): number | null => {
    let digits = '';
    while (i < keys.length) {
      const char = keys.charAt(i);
      if (!/[0-9]/.test(char) || (digits === '' && char === '0')) break;
      digits += char;
      i += 1;
    }
    return digits === '' ? null : Math.min(MAX_COUNT, Number(digits));
  };
  const readMotion = (): Motion | 'incomplete' | 'invalid' => {
    const char = keys.charAt(i);
    if (char === 'g') {
      if (i + 1 >= keys.length) return 'incomplete';
      return keys.charAt(i + 1) === 'g' && i + 2 === keys.length ? 'gg' : 'invalid';
    }
    return MOTIONS.has(char) && i + 1 === keys.length ? (char as Motion) : 'invalid';
  };

  const count = readCount();
  if (i >= keys.length) return 'incomplete';
  const char = keys.charAt(i);

  if (visual) {
    if (i + 1 === keys.length && (char === 'd' || char === 'x')) {
      return { kind: 'visual-operator', operator: 'd' };
    }
    if (i + 1 === keys.length && (char === 'c' || char === 'y')) {
      return { kind: 'visual-operator', operator: char };
    }
    if (i + 1 === keys.length && (char === 'v' || char === 'V')) {
      return { kind: 'action', action: char, count: 1 };
    }
    const motion = readMotion();
    return motion === 'incomplete' || motion === 'invalid'
      ? motion
      : { kind: 'motion', motion, count };
  }

  const shorthand = SHORTHANDS[char];
  if (shorthand !== undefined) {
    return i + 1 === keys.length
      ? { kind: 'operator', operator: shorthand[0], motion: shorthand[1], count }
      : 'invalid';
  }

  if (char === 'd' || char === 'c' || char === 'y') {
    i += 1;
    const inner = readCount();
    if (i >= keys.length) return 'incomplete';
    if (keys.charAt(i) === char) {
      return i + 1 === keys.length
        ? { kind: 'line-operator', operator: char, count: multiply(count, inner) ?? 1 }
        : 'invalid';
    }
    const motion = readMotion();
    if (motion === 'incomplete' || motion === 'invalid') return motion;
    return { kind: 'operator', operator: char, motion, count: multiply(count, inner) };
  }

  if (ACTIONS.has(char)) {
    return i + 1 === keys.length
      ? { kind: 'action', action: char as Action, count: count ?? 1 }
      : 'invalid';
  }

  const motion = readMotion();
  if (motion === 'incomplete' || motion === 'invalid') return motion;
  return { kind: 'motion', motion, count };
}

interface Target {
  readonly pos: number;
  /** The motion takes whole lines when an operator applies it (`j`, `k`, `gg`, `G`). */
  readonly linewise: boolean;
  /** The character under the target is part of an operator's range (`e`, `$`). */
  readonly inclusive: boolean;
}

/**
 * Where a motion goes from `from`. `forOperator` is Vim's operator-pending mode, where `l` may
 * reach the end of the block and `w` stops at the end of the block rather than crossing it.
 */
function motionTarget(
  doc: ProseMirrorNode,
  from: number,
  motion: Motion,
  count: number | null,
  forOperator: boolean,
): Target | null {
  const origin = lineAt(doc, from);
  if (origin === null) return null;
  let line: Line = origin;
  let offset = from - line.start;
  const times = count ?? 1;
  const at = (inclusive: boolean, linewise = false): Target => ({
    pos: line.start + offset,
    inclusive,
    linewise,
  });

  switch (motion) {
    case 'h':
      for (let step = 0; step < times && offset > 0; step += 1) {
        offset = previousGrapheme(line, offset);
      }
      return at(false);
    case 'l': {
      const limit = forOperator ? line.size : lastCharacter(line);
      for (let step = 0; step < times && offset < limit; step += 1) {
        offset = Math.min(limit, nextGrapheme(line, offset));
      }
      return at(false);
    }
    case 'j':
    case 'k': {
      const column = offset;
      for (let step = 0; step < times; step += 1) {
        const next = adjacentLine(doc, line, motion === 'j' ? 1 : -1);
        if (next === null) break;
        line = next;
      }
      offset = Math.min(column, lastCharacter(line));
      return at(false, true);
    }
    case 'w':
      for (let step = 0; step < times; step += 1) {
        const next = nextWordStart(line, offset);
        if (next !== null) {
          offset = next;
          continue;
        }
        if (forOperator) {
          offset = line.size;
          break;
        }
        const following = adjacentLine(doc, line, 1);
        if (following === null) {
          offset = lastCharacter(line);
          break;
        }
        line = following;
        offset = firstWordOrStart(line);
      }
      return at(false);
    case 'b':
      for (let step = 0; step < times; step += 1) {
        const previous = previousWordStart(line, offset);
        if (previous !== null) {
          offset = previous;
          continue;
        }
        const preceding = adjacentLine(doc, line, -1);
        if (preceding === null) {
          offset = 0;
          break;
        }
        line = preceding;
        offset = lastWordOrStart(line);
      }
      return at(false);
    case 'e':
      for (let step = 0; step < times; step += 1) {
        let found: number | null = null;
        let search: Line | null = line;
        let after = offset;
        while (search !== null && found === null) {
          for (const word of words(search)) {
            // Cheap rejection first: a word whose last code unit is behind the cursor cannot hold
            // a target, and measuring each one's last grapheme would make `e` linear in graphemes.
            if (word.end - 1 <= after) continue;
            const last = previousGrapheme(search, word.end);
            if (last > after) {
              found = last;
              break;
            }
          }
          if (found === null) {
            search = adjacentLine(doc, search, 1);
            after = -1;
          }
        }
        if (found === null || search === null) break;
        line = search;
        offset = found;
      }
      return at(true);
    case '0':
      offset = 0;
      return at(false);
    case '^':
      offset = firstNonBlank(line);
      return at(false);
    case '$':
      for (let step = 1; step < times; step += 1) {
        const next = adjacentLine(doc, line, 1);
        if (next === null) break;
        line = next;
      }
      offset = lastCharacter(line);
      return at(true);
    case 'gg':
    case 'G': {
      const found = count === null ? edgeLine(doc, motion === 'gg' ? 1 : -1) : nthLine(doc, count);
      if (found === null) return null;
      line = found;
      offset = firstNonBlank(line);
      return at(false, true);
    }
  }
}

/** The end of the character at `pos`, for an inclusive motion or a Visual selection. */
function characterEnd(doc: ProseMirrorNode, pos: number): number {
  const line = lineAt(doc, pos);
  return line === null ? pos : line.start + nextGrapheme(line, pos - line.start);
}

function visualSelection(
  doc: ProseMirrorNode,
  anchor: number,
  head: number,
  linewise: boolean,
): TextSelection {
  if (linewise) {
    const anchorLine = lineAt(doc, anchor);
    const headLine = lineAt(doc, head);
    if (anchorLine !== null && headLine !== null) {
      return head >= anchor
        ? TextSelection.create(doc, anchorLine.start, headLine.start + headLine.size)
        : TextSelection.create(doc, anchorLine.start + anchorLine.size, headLine.start);
    }
  }
  return head >= anchor
    ? TextSelection.create(doc, anchor, characterEnd(doc, head))
    : TextSelection.create(doc, characterEnd(doc, anchor), head);
}

/** The block-level range for whole lines from `first` to `last`, inclusive. */
function lineRange(first: Line, last: Line): { readonly from: number; readonly to: number } {
  return { from: first.start - 1, to: last.start + last.size + 1 };
}

function normalCaretIn(doc: ProseMirrorNode, near: number): TextSelection | null {
  const bounded = Math.max(0, Math.min(doc.content.size, near));
  const found =
    Selection.findFrom(doc.resolve(bounded), 1, true) ??
    Selection.findFrom(doc.resolve(bounded), -1, true);
  if (!(found instanceof TextSelection)) return null;
  const line = lineAt(doc, found.head);
  return line === null ? null : caretAt(doc, line.start + firstNonBlank(line));
}

/** Clamps a caret onto a character, as Normal mode requires after an edit. */
function onCharacter(doc: ProseMirrorNode, pos: number): TextSelection {
  const line = lineAt(doc, pos);
  if (line === null) return caretAt(doc, pos);
  return caretAt(doc, line.start + Math.min(pos - line.start, lastCharacter(line)));
}

function finish(
  view: EditorView,
  transaction: Transaction,
  meta: VimMotionMeta,
  selection: Selection | null,
): void {
  transaction.setMeta(vimMotionsKey, { pending: '', anchor: null, head: null, ...meta });
  if (selection !== null) transaction.setSelection(selection);
  view.dispatch(transaction.scrollIntoView());
}

type Range =
  | { readonly linewise: false; readonly from: number; readonly to: number }
  | { readonly linewise: true; readonly first: Line; readonly last: Line };

/** Applies d, c or y to a range and leaves the editor in the mode Vim would. */
function applyOperator(view: EditorView, operator: Operator, range: Range): void {
  const { state } = view;
  const { doc } = state;
  const transaction = state.tr;

  if (!range.linewise) {
    const { from, to } = range;
    if (to > from) register = { slice: doc.slice(from, to), linewise: false };
    if (operator === 'y') {
      finish(
        view,
        transaction.setMeta('addToHistory', false),
        { mode: 'normal' },
        onCharacter(doc, from),
      );
      return;
    }
    transaction.delete(from, to);
    if (operator === 'c') {
      finish(view, transaction, { mode: 'insert' }, caretAt(transaction.doc, from));
      return;
    }
    finish(view, transaction, { mode: 'normal' }, onCharacter(transaction.doc, from));
    return;
  }

  const [first, last] =
    range.first.start <= range.last.start ? [range.first, range.last] : [range.last, range.first];
  const blocks = lineRange(first, last);
  register = { slice: doc.slice(blocks.from, blocks.to), linewise: true };

  if (operator === 'y') {
    finish(
      view,
      transaction.setMeta('addToHistory', false),
      { mode: 'normal' },
      caretAt(doc, first.start + firstNonBlank(first)),
    );
    return;
  }
  if (operator === 'c') {
    // Joining the lines into the first one keeps its type: changing a heading leaves a heading.
    transaction.delete(first.start, last.start + last.size);
    finish(view, transaction, { mode: 'insert' }, caretAt(transaction.doc, first.start));
    return;
  }
  transaction.deleteRange(blocks.from, blocks.to);
  if (transaction.doc.eq(doc)) {
    // The document's only lines cannot be removed outright; emptying them is the closest edit.
    transaction.delete(first.start, last.start + last.size);
  }
  finish(view, transaction, { mode: 'normal' }, normalCaretIn(transaction.doc, blocks.from));
}

function paste(view: EditorView, after: boolean, count: number): void {
  const saved = register;
  const cursor = normalCursor(view.state);
  if (saved === null || cursor === null) {
    dispatch(view, { pending: '' });
    return;
  }
  const { doc } = view.state;
  const line = lineAt(doc, cursor);
  if (line === null) return;
  const transaction = view.state.tr;

  if (saved.linewise) {
    const at = after ? line.start + line.size + 1 : line.start - 1;
    for (let step = 0; step < count; step += 1) {
      transaction.replace(at, at, saved.slice);
    }
    finish(view, transaction, { mode: 'normal' }, normalCaretIn(transaction.doc, at));
    return;
  }

  let at = after && line.size > 0 ? characterEnd(doc, cursor) : cursor;
  for (let step = 0; step < count; step += 1) {
    const before = transaction.steps.length;
    transaction.replace(at, at, saved.slice);
    at = transaction.mapping.slice(before).map(at, 1);
  }
  const landed = lineAt(transaction.doc, at);
  const last = landed === null ? at : landed.start + previousGrapheme(landed, at - landed.start);
  finish(view, transaction, { mode: 'normal' }, onCharacter(transaction.doc, last));
}

/** `o` and `O`: a new line below or above, made by the same Enter the editor already has. */
function openLine(view: EditorView, editor: Editor, below: boolean): void {
  const cursor = normalCursor(view.state);
  const line = cursor === null ? null : lineAt(view.state.doc, cursor);
  if (line === null) {
    dispatch(view, { pending: '' });
    return;
  }
  const code = line.node.type.spec.code === true;
  dispatch(
    view,
    { mode: 'insert', pending: '' },
    caretAt(view.state.doc, below ? line.start + line.size : line.start),
  );
  editor.commands.keyboardShortcut('Enter');
  if (below || code) {
    if (!below) dispatch(view, {}, caretAt(view.state.doc, line.start));
    return;
  }
  // Enter at the start of a block leaves the caret in the original, now second, block.
  const moved = lineAt(view.state.doc, view.state.selection.head);
  const opened = moved === null ? null : adjacentLine(view.state.doc, moved, -1);
  if (opened !== null) dispatch(view, {}, caretAt(view.state.doc, opened.start + opened.size));
}

function enterInsert(view: EditorView, selection: Selection | null): void {
  const safe = selection ?? insertFallback(view.state);
  dispatch(
    view,
    safe === null ? { pending: '' } : { mode: 'insert', pending: '' },
    safe ?? undefined,
  );
}

function runAction(view: EditorView, editor: Editor, action: Action, count: number): void {
  const { state } = view;
  const vim = current(state);
  const cursor = isVisual(vim.mode) ? vim.head : normalCursor(state);
  const line = cursor === null ? null : lineAt(state.doc, cursor);

  switch (action) {
    case 'i':
      enterInsert(view, cursor === null ? null : caretAt(state.doc, cursor));
      return;
    case 'a':
      enterInsert(
        view,
        cursor === null || line === null
          ? null
          : caretAt(state.doc, line.size === 0 ? cursor : characterEnd(state.doc, cursor)),
      );
      return;
    case 'I':
      enterInsert(
        view,
        line === null ? null : caretAt(state.doc, line.start + firstNonBlank(line)),
      );
      return;
    case 'A':
      enterInsert(view, line === null ? null : caretAt(state.doc, line.start + line.size));
      return;
    case 'o':
    case 'O':
      openLine(view, editor, action === 'o');
      return;
    case 'p':
    case 'P':
      paste(view, action === 'p', count);
      return;
    case 'u':
      dispatch(view, { pending: '' });
      for (let step = 0; step < count; step += 1) {
        if (!undo(view.state)) break;
      }
      settleAfterHistory(view);
      return;
    case 'v':
    case 'V': {
      const wanted: VimMode = action === 'v' ? 'visual' : 'visual-line';
      if (vim.mode === wanted && vim.head !== null) {
        dispatch(
          view,
          { mode: 'normal', pending: '', anchor: null, head: null },
          onCharacter(state.doc, vim.head),
        );
        return;
      }
      if (cursor === null) return;
      const anchor = isVisual(vim.mode) && vim.anchor !== null ? vim.anchor : cursor;
      dispatch(
        view,
        { mode: wanted, pending: '', anchor, head: cursor },
        visualSelection(state.doc, anchor, cursor, wanted === 'visual-line'),
      );
      return;
    }
  }
}

/** After undo or redo, Normal mode's cursor goes back onto a character. */
function settleAfterHistory(view: EditorView): void {
  const head = textHead(view.state);
  if (head !== null) dispatch(view, {}, onCharacter(view.state.doc, head));
}

function runCommand(view: EditorView, editor: Editor, command: Command): void {
  const { state } = view;
  const vim = current(state);

  if (command.kind === 'action') {
    runAction(view, editor, command.action, command.count);
    return;
  }

  if (command.kind === 'visual-operator') {
    if (vim.anchor === null || vim.head === null) return;
    if (vim.mode === 'visual-line') {
      const first = lineAt(state.doc, vim.anchor);
      const last = lineAt(state.doc, vim.head);
      if (first !== null && last !== null) {
        applyOperator(view, command.operator, { linewise: true, first, last });
      }
      return;
    }
    const from = Math.min(vim.anchor, vim.head);
    const to = characterEnd(state.doc, Math.max(vim.anchor, vim.head));
    applyOperator(view, command.operator, { linewise: false, from, to });
    return;
  }

  if (command.kind === 'line-operator') {
    const cursor = normalCursor(state);
    const first = cursor === null ? null : lineAt(state.doc, cursor);
    if (cursor === null || first === null) return;
    const below = motionTarget(state.doc, cursor, 'j', command.count - 1, true);
    const last = below === null || command.count <= 1 ? first : lineAt(state.doc, below.pos);
    applyOperator(view, command.operator, { linewise: true, first, last: last ?? first });
    return;
  }

  const visual = isVisual(vim.mode);
  const from = visual ? vim.head : normalCursor(state);
  if (from === null) return;

  if (command.kind === 'motion') {
    const target = motionTarget(state.doc, from, command.motion, command.count, false);
    if (target === null) {
      dispatch(view, { pending: '' });
      return;
    }
    if (visual && vim.anchor !== null) {
      dispatch(
        view,
        { pending: '', head: target.pos },
        visualSelection(state.doc, vim.anchor, target.pos, vim.mode === 'visual-line'),
      );
      return;
    }
    dispatch(view, { pending: '' }, caretAt(state.doc, target.pos));
    return;
  }

  // `cw` changes to the end of the word, as `ce` would: Vim's long-standing special case.
  const motion = command.operator === 'c' && command.motion === 'w' ? 'e' : command.motion;
  const target = motionTarget(state.doc, from, motion, command.count, true);
  if (target === null) {
    dispatch(view, { pending: '' });
    return;
  }
  if (target.linewise) {
    const first = lineAt(state.doc, from);
    const last = lineAt(state.doc, target.pos);
    if (first !== null && last !== null) {
      applyOperator(view, command.operator, { linewise: true, first, last });
    }
    return;
  }
  const start = Math.min(from, target.pos);
  const end = target.inclusive
    ? characterEnd(state.doc, Math.max(from, target.pos))
    : Math.max(from, target.pos);
  applyOperator(view, command.operator, { linewise: false, from: start, to: end });
}

const nativeNavigationKeys = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

function isDestructiveShortcut(event: KeyboardEvent, isApplePlatform: boolean): boolean {
  return (
    event.key === 'Backspace' ||
    event.key === 'Delete' ||
    event.key === 'Enter' ||
    (isApplePlatform &&
      ((event.ctrlKey && (event.key === 'h' || event.key === 'd')) ||
        (event.altKey && event.key === 'd')))
  );
}

function handleCommandKey(view: EditorView, editor: Editor, event: KeyboardEvent): boolean {
  const vim = current(view.state);

  if (event.key === 'Escape') {
    if (isVisual(vim.mode) && vim.head !== null) {
      dispatch(
        view,
        { mode: 'normal', pending: '', anchor: null, head: null },
        onCharacter(view.state.doc, vim.head),
      );
    } else if (vim.pending !== '') {
      dispatch(view, { pending: '' });
    }
    return true;
  }

  if (event.key.length !== 1) {
    // Normal mode never inserts or deletes by itself. Arrows and Tab were let through earlier.
    if (vim.pending !== '') dispatch(view, { pending: '' });
    return event.key === 'Backspace' || event.key === 'Delete' || event.key === 'Enter';
  }

  const parsed = parse(vim.pending + event.key, isVisual(vim.mode));
  if (parsed === 'incomplete') {
    dispatch(view, { pending: vim.pending + event.key });
    return true;
  }
  if (parsed === 'invalid') {
    if (vim.pending !== '') dispatch(view, { pending: '' });
    return true;
  }
  runCommand(view, editor, parsed);
  return true;
}

function cursorDecorations(state: EditorState): DecorationSet | null {
  const vim = current(state);
  if (!vim.enabled || vim.mode !== 'normal') return null;
  const cursor = normalCursor(state);
  const line = cursor === null ? null : lineAt(state.doc, cursor);
  if (cursor === null || line === null) return null;
  if (line.size === 0) {
    return DecorationSet.create(state.doc, [
      Decoration.widget(
        cursor,
        () => {
          const block = document.createElement('span');
          block.className = 'nix-vim-cursor';
          block.setAttribute('aria-hidden', 'true');
          block.textContent = ' ';
          return block;
        },
        { key: 'nix-vim-cursor', side: 1, ignoreSelection: true },
      ),
    ]);
  }
  return DecorationSet.create(state.doc, [
    Decoration.inline(cursor, characterEnd(state.doc, cursor), { class: 'nix-vim-cursor' }),
  ]);
}

function vimPlugin(editor: Editor, isApplePlatform: boolean): Plugin<VimMotionState> {
  return new Plugin<VimMotionState>({
    key: vimMotionsKey,
    state: {
      init: () => INITIAL,
      apply(transaction, value) {
        let next = value;
        if (transaction.docChanged && value.anchor !== null && value.head !== null) {
          next = {
            ...next,
            anchor: transaction.mapping.map(value.anchor),
            head: transaction.mapping.map(value.head),
          };
        }
        const meta: unknown = transaction.getMeta(vimMotionsKey);
        if (typeof meta === 'object' && meta !== null) {
          return { ...next, ...(meta as VimMotionMeta) };
        }
        // A click, a toolbar command or any other outside selection change abandons a half-typed
        // command and leaves Visual mode, the way a mouse click does in Vim. A colleague's edit
        // also restores this editor's selection, and must not count as this person moving it.
        if (
          transaction.getMeta(ySyncPluginKey) === undefined &&
          transaction.selectionSet &&
          (next.pending !== '' || isVisual(next.mode))
        ) {
          return {
            ...next,
            pending: '',
            mode: isVisual(next.mode) ? 'normal' : next.mode,
            anchor: null,
            head: null,
          };
        }
        return next;
      },
    },
    props: {
      decorations: cursorDecorations,
      attributes(state): Record<string, string> {
        const vim = current(state);
        return vim.enabled && vim.mode !== 'insert' ? { class: 'nix-vim-command' } : {};
      },
      handleKeyDown(view, event) {
        const vim = current(view.state);
        if (
          !vim.enabled ||
          event.isComposing ||
          view.composing ||
          isLegacyCompositionKey(event) ||
          !inTextControl(event)
        ) {
          return false;
        }
        if (vim.mode === 'insert') {
          if (event.key !== 'Escape') {
            return false;
          }
          // Vim steps back onto the last character typed when Insert ends.
          const head = textHead(view.state);
          const line = head === null ? null : lineAt(view.state.doc, head);
          const back =
            head === null || line === null
              ? undefined
              : caretAt(view.state.doc, line.start + previousGrapheme(line, head - line.start));
          dispatch(view, { mode: 'normal', pending: '' }, back);
          return true;
        }
        if (event.metaKey || event.ctrlKey || event.altKey) {
          if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === 'r') {
            // Ctrl+R is redo in Vim and reload in a browser on Windows and Linux; Vim wins here.
            dispatch(view, { pending: '' });
            redo(view.state);
            settleAfterHistory(view);
            return true;
          }
          if (vim.pending !== '') {
            dispatch(view, { pending: '' });
          }
          return isDestructiveShortcut(event, isApplePlatform);
        }
        return handleCommandKey(view, editor, event);
      },
      handleTextInput(view) {
        const vim = current(view.state);
        return vim.enabled && vim.mode !== 'insert';
      },
      handlePaste(view) {
        const vim = current(view.state);
        return vim.enabled && vim.mode !== 'insert';
      },
      handleDrop(view, _event, _slice, moved) {
        const vim = current(view.state);
        return vim.enabled && vim.mode !== 'insert' && !moved;
      },
      handleDOMEvents: {
        blur(view) {
          if (current(view.state).pending !== '') {
            dispatch(view, { pending: '' });
          }
          return false;
        },
        keydown(view, event) {
          const vim = current(view.state);
          // Returning true from a raw DOM handler skips ProseMirror's rich-node keymaps. Leaving
          // the event uncancelled preserves native focus traversal and caret navigation.
          return (
            vim.enabled &&
            vim.mode !== 'insert' &&
            (event.key === 'Tab' ||
              (!event.metaKey &&
                !event.ctrlKey &&
                !event.altKey &&
                nativeNavigationKeys.has(event.key))) &&
            inTextControl(event)
          );
        },
        cut(view, event) {
          const vim = current(view.state);
          if (vim.enabled && vim.mode !== 'insert' && inTextControl(event)) {
            event.preventDefault();
            return true;
          }
          return false;
        },
        beforeinput(view, event) {
          const vim = current(view.state);
          if (vim.enabled && vim.mode !== 'insert' && inTextControl(event)) {
            event.preventDefault();
            return true;
          }
          return false;
        },
      },
    },
  });
}

export function vimMode(state: EditorState): VimMode {
  return current(state).mode;
}

export function vimStatusMode(state: EditorState): VimMode | null {
  const vim = current(state);
  return vim.enabled ? vim.mode : null;
}

/** The keys typed toward a command that is not complete yet, for the status line. */
export function vimPendingKeys(state: EditorState): string {
  return current(state).pending;
}

/** How the status line names a mode. */
export function vimModeLabel(mode: VimMode): string {
  return mode === 'visual-line' ? 'visual line' : mode;
}

export function setVimEnabled(view: EditorView, enabled: boolean): void {
  const next: VimMode = enabled ? 'normal' : 'insert';
  const vim = current(view.state);
  if (vim.enabled !== enabled || vim.mode !== next || vim.pending !== '' || vim.anchor !== null) {
    dispatch(view, { enabled, mode: next, pending: '', anchor: null, head: null });
  }
}

/** A bounded modal preset: exact supported keys are disclosed in Settings. */
export const VimMotions = Extension.create<VimMotionsOptions>({
  name: 'vimMotions',
  priority: 900,
  addOptions() {
    return { isApplePlatform: defaultIsApplePlatform };
  },
  addProseMirrorPlugins() {
    return [vimPlugin(this.editor, this.options.isApplePlatform)];
  },
});
