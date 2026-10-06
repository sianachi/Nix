import { Extension } from '@tiptap/core';
import type { Schema, Slice } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection, type EditorState } from '@tiptap/pm/state';
import { Transform } from '@tiptap/pm/transform';
import type { EditorView } from '@tiptap/pm/view';
import { redo, undo, ySyncPluginKey } from 'y-prosemirror';

import { useKeyboardModeStore } from './keyboard-mode-store';
import {
  adjacentLine,
  edgeLine,
  lineAt,
  lineText,
  nextGrapheme,
  nextWordEnd,
  previousGrapheme,
  previousWordStart,
  type Line,
} from './text-motions';

/**
 * Emacs basics: the movement, mark and kill-ring keys people's fingers already know.
 *
 * **Explicit on every platform.** macOS gives a text field a few Emacs chords of its own, but they
 * are partial, and Windows and Linux have none - there Ctrl+F is find and Ctrl+P is print. Every
 * chord below is implemented here against ProseMirror positions, so it does the same thing
 * everywhere and inside any block. While this preset is on, those chords mean their Emacs
 * meaning, which is the point of choosing it; the browser keeps the few it never lets a page
 * have (Ctrl+N, Ctrl+W and Ctrl+T on Windows and Linux).
 *
 * **Lines.** Ctrl+A/E work on the text block, like Emacs's logical lines. Ctrl+N/P move by the line
 * as displayed, which is what Emacs does by default, by asking the browser to move a collapsed
 * selection one line and reading back where it landed.
 *
 * **The mark.** Ctrl+Space sets it at the caret and every motion after that extends the region from
 * it, until Ctrl+G, an edit, or a click deactivates it.
 *
 * **The kill ring** is shared by every editor on the page and lives only in memory. A kill keeps
 * the killed content as a slice, formatting included, and consecutive kills append into one entry,
 * so Ctrl+K Ctrl+K Ctrl+K takes a line, its break and the next line together. Ctrl+Y yanks the
 * latest; Alt+Y straight after replaces it with the one before.
 *
 * **Undo** is the collaborative, client-local history, the same one Mod+Z uses.
 */

interface EmacsState {
  /** The active mark, mapped through every edit; null when no region is being made. */
  readonly mark: number | null;
  /** The previous command was a kill, so the next one appends to the same ring entry. */
  readonly lastKill: boolean;
  /** What the previous command yanked, so Alt+Y can swap it. */
  readonly yank: { readonly from: number; readonly to: number; readonly index: number } | null;
}

type EmacsMeta = Partial<EmacsState>;

export const emacsKeymapKey = new PluginKey<EmacsState>('nixEmacsKeymap');

const INITIAL: EmacsState = { mark: null, lastKill: false, yank: null };
const RING_SIZE = 60;
const ring: Slice[] = [];

function current(state: EditorState): EmacsState {
  return emacsKeymapKey.getState(state) ?? INITIAL;
}

/** The kill ring's entries, newest first; exposed for tests and nothing else. */
export function emacsKillRing(): readonly Slice[] {
  return ring;
}

/** Joins two slices as if the second had been typed straight after the first. */
function appendSlices(schema: Schema, first: Slice, second: Slice): Slice {
  try {
    const empty = schema.topNodeType.createAndFill();
    if (empty === null) return second;
    const transform = new Transform(empty);
    transform.replace(1, 1, first);
    const middle = transform.mapping.map(1, 1);
    transform.replace(middle, middle, second);
    return transform.doc.slice(transform.mapping.map(1, -1), transform.mapping.map(1, 1));
  } catch {
    // A pair the schema cannot place side by side keeps the newer kill rather than losing both.
    return second;
  }
}

function pushKill(schema: Schema, slice: Slice, append: boolean): void {
  const latest = ring[0];
  if (append && latest !== undefined) {
    ring[0] = appendSlices(schema, latest, slice);
    return;
  }
  ring.unshift(slice);
  ring.length = Math.min(ring.length, RING_SIZE);
}

function head(state: EditorState): number | null {
  const { selection } = state;
  return selection instanceof TextSelection ? selection.head : null;
}

/** Moves the caret, extending the region from the mark when one is active. */
function moveTo(view: EditorView, target: number): void {
  const { mark } = current(view.state);
  const selection =
    mark === null
      ? TextSelection.create(view.state.doc, target)
      : TextSelection.create(view.state.doc, mark, target);
  view.dispatch(
    view.state.tr.setSelection(selection).setMeta(emacsKeymapKey, { mark }).scrollIntoView(),
  );
}

type Locate = (state: EditorState, from: number, line: Line) => number | null;

function motion(locate: Locate): (view: EditorView) => boolean {
  return (view) => {
    const from = head(view.state);
    const line = from === null ? null : lineAt(view.state.doc, from);
    if (from === null || line === null) return false;
    const target = locate(view.state, from, line);
    if (target !== null) moveTo(view, target);
    return true;
  };
}

const forwardChar: Locate = (state, from, line) => {
  const offset = from - line.start;
  if (offset < line.size) return line.start + nextGrapheme(line, offset);
  return adjacentLine(state.doc, line, 1)?.start ?? null;
};

const backwardChar: Locate = (state, from, line) => {
  const offset = from - line.start;
  if (offset > 0) return line.start + previousGrapheme(line, offset);
  const previous = adjacentLine(state.doc, line, -1);
  return previous === null ? null : previous.start + previous.size;
};

/** Alt+F: to the end of the next word, across blocks. */
const forwardWord: Locate = (state, from, line) => {
  let search = line;
  let after = from - line.start;
  for (;;) {
    const end = nextWordEnd(search, after);
    if (end !== null) return search.start + end;
    const next = adjacentLine(state.doc, search, 1);
    if (next === null) return search.start + search.size;
    search = next;
    after = -1;
  }
};

/** Alt+B: to the start of the previous word, across blocks. */
const backwardWord: Locate = (state, from, line) => {
  let search = line;
  let before = from - line.start;
  for (;;) {
    const start = previousWordStart(search, before);
    if (start !== null) return search.start + start;
    const previous = adjacentLine(state.doc, search, -1);
    if (previous === null) return search.start;
    search = previous;
    before = previous.size + 1;
  }
};

const lineStart: Locate = (_state, _from, line) => line.start;
const lineEnd: Locate = (_state, _from, line) => line.start + line.size;
const documentStart: Locate = (state) => edgeLine(state.doc, 1)?.start ?? null;
const documentEnd: Locate = (state) => {
  const last = edgeLine(state.doc, -1);
  return last === null ? null : last.start + last.size;
};

/**
 * Ctrl+N/P: one displayed line down or up. The browser knows where a wrapped line breaks and
 * ProseMirror does not, so a collapsed DOM selection is moved with `Selection.modify` and read
 * back. Without it (a non-browser test environment), the next or previous block at the same column.
 */
function lineMove(direction: 1 | -1): (view: EditorView) => boolean {
  return (view) => {
    const from = head(view.state);
    const line = from === null ? null : lineAt(view.state.doc, from);
    if (from === null || line === null) return false;
    const selection = view.dom.ownerDocument.getSelection();
    if (selection !== null && typeof selection.modify === 'function' && view.hasFocus()) {
      try {
        const { node, offset } = view.domAtPos(from);
        selection.collapse(node, offset);
        selection.modify('move', direction === 1 ? 'forward' : 'backward', 'line');
        if (selection.focusNode !== null) {
          const target = view.posAtDOM(selection.focusNode, selection.focusOffset);
          if (lineAt(view.state.doc, target) !== null) {
            moveTo(view, target);
            return true;
          }
        }
      } catch {
        // A position the DOM cannot express falls back to block movement below.
      }
    }
    const next = adjacentLine(view.state.doc, line, direction);
    if (next !== null) moveTo(view, next.start + Math.min(from - line.start, next.size));
    return true;
  };
}

/** Removes [from, to), records it in the kill ring, and leaves the caret at `from`. */
function kill(view: EditorView, from: number, to: number): boolean {
  if (to <= from) return true;
  const { state } = view;
  const { lastKill } = current(state);
  pushKill(state.schema, state.doc.slice(from, to), lastKill);
  view.dispatch(
    state.tr
      .delete(from, to)
      .setMeta(emacsKeymapKey, { mark: null, lastKill: true })
      .scrollIntoView(),
  );
  return true;
}

/** Ctrl+K: the rest of the block, or the break after it when only blanks are left. */
function killLine(view: EditorView): boolean {
  const from = head(view.state);
  const line = from === null ? null : lineAt(view.state.doc, from);
  if (from === null || line === null) return false;
  const rest = lineText(line, from - line.start);
  if (/[^\t ]/u.test(rest)) return kill(view, from, line.start + line.size);
  const next = adjacentLine(view.state.doc, line, 1);
  return kill(view, from, next === null ? line.start + line.size : next.start);
}

/** Alt+D: to the end of the next word. */
function killWord(view: EditorView): boolean {
  const from = head(view.state);
  const line = from === null ? null : lineAt(view.state.doc, from);
  if (from === null || line === null) return false;
  const to = forwardWord(view.state, from, line);
  return to === null ? true : kill(view, from, to);
}

/** The region: mark to caret, or a selection made some other way. */
function region(state: EditorState): { readonly from: number; readonly to: number } | null {
  const { mark } = current(state);
  const caret = head(state);
  if (mark !== null && caret !== null) {
    return { from: Math.min(mark, caret), to: Math.max(mark, caret) };
  }
  return state.selection.empty ? null : { from: state.selection.from, to: state.selection.to };
}

/** Ctrl+W. */
function killRegion(view: EditorView): boolean {
  const range = region(view.state);
  return range === null ? true : kill(view, range.from, range.to);
}

/** Alt+W: copy the region into the kill ring and deactivate the mark. */
function copyRegion(view: EditorView): boolean {
  const range = region(view.state);
  if (range === null) return true;
  pushKill(view.state.schema, view.state.doc.slice(range.from, range.to), false);
  const caret = head(view.state) ?? range.to;
  view.dispatch(
    view.state.tr
      .setSelection(TextSelection.create(view.state.doc, caret))
      .setMeta(emacsKeymapKey, { mark: null }),
  );
  return true;
}

function insertAt(view: EditorView, from: number, to: number, slice: Slice, index: number): void {
  const transaction = view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to));
  transaction.replaceSelection(slice);
  const start = transaction.mapping.map(from, -1);
  const end = transaction.selection.head;
  transaction.setMeta(emacsKeymapKey, { mark: null, yank: { from: start, to: end, index } });
  view.dispatch(transaction.scrollIntoView());
}

/** Ctrl+Y. */
function yank(view: EditorView): boolean {
  const latest = ring[0];
  const caret = head(view.state);
  if (latest === undefined || caret === null) return true;
  insertAt(view, caret, caret, latest, 0);
  return true;
}

/** Alt+Y, straight after a yank: swap what was yanked for the next older kill. */
function yankPop(view: EditorView): boolean {
  const { yank: last } = current(view.state);
  if (last === null || ring.length < 2) return true;
  const index = (last.index + 1) % ring.length;
  const slice = ring[index];
  if (slice !== undefined) insertAt(view, last.from, last.to, slice, index);
  return true;
}

/** Ctrl+Space: set the mark here, or deactivate it when it is already here. */
function setMark(view: EditorView): boolean {
  const caret = head(view.state);
  if (caret === null) return false;
  const { mark } = current(view.state);
  view.dispatch(
    view.state.tr
      .setSelection(TextSelection.create(view.state.doc, caret))
      .setMeta(emacsKeymapKey, { mark: mark === caret ? null : caret }),
  );
  return true;
}

/** Ctrl+G: deactivate the mark and collapse the region onto the caret. */
function keyboardQuit(view: EditorView): boolean {
  const caret = head(view.state);
  const transaction = view.state.tr.setMeta(emacsKeymapKey, { mark: null });
  if (caret !== null) transaction.setSelection(TextSelection.create(view.state.doc, caret));
  view.dispatch(transaction);
  return true;
}

/** Ctrl+D: delete the next character, joining the next block at the end of this one. */
function deleteChar(view: EditorView): boolean {
  const { selection } = view.state;
  if (!selection.empty) {
    view.dispatch(view.state.tr.deleteSelection().scrollIntoView());
    return true;
  }
  const from = head(view.state);
  const line = from === null ? null : lineAt(view.state.doc, from);
  if (from === null || line === null) return false;
  const to = forwardChar(view.state, from, line);
  if (to !== null && to > from) view.dispatch(view.state.tr.delete(from, to).scrollIntoView());
  return true;
}

function emacsPlugin(): Plugin<EmacsState> {
  return new Plugin<EmacsState>({
    key: emacsKeymapKey,
    state: {
      init: () => INITIAL,
      apply(transaction, value) {
        const mapped: EmacsState = {
          mark: value.mark === null ? null : transaction.mapping.map(value.mark),
          lastKill: value.lastKill,
          yank:
            value.yank === null
              ? null
              : {
                  from: transaction.mapping.map(value.yank.from, -1),
                  to: transaction.mapping.map(value.yank.to),
                  index: value.yank.index,
                },
        };
        const meta: unknown = transaction.getMeta(emacsKeymapKey);
        if (typeof meta === 'object' && meta !== null) {
          const update = meta as EmacsMeta;
          return {
            mark: update.mark === undefined ? mapped.mark : update.mark,
            lastKill: update.lastKill ?? false,
            yank: update.yank ?? null,
          };
        }
        // A colleague's edit moves nothing of this person's.
        if (transaction.getMeta(ySyncPluginKey) !== undefined) return mapped;
        // Typing, a click or any other command ends the region and the kill/yank sequence.
        if (transaction.docChanged || transaction.selectionSet) return INITIAL;
        return value;
      },
    },
  });
}

export const EmacsKeymap = Extension.create({
  name: 'emacsKeymap',
  // Above the platform keymap (Ctrl+A select-all, Ctrl+B bold on Windows and Linux) and the
  // collaborative history keys, so a chord this preset owns always means its Emacs meaning.
  priority: 1100,

  addProseMirrorPlugins() {
    return [emacsPlugin()];
  },

  addKeyboardShortcuts() {
    const bind = (command: (view: EditorView) => boolean) => (): boolean =>
      useKeyboardModeStore.getState().mode === 'emacs' && command(this.editor.view);
    const undoLocal = (view: EditorView): boolean => {
      undo(view.state);
      return true;
    };
    const redoLocal = (view: EditorView): boolean => {
      redo(view.state);
      return true;
    };
    return {
      'Ctrl-f': bind(motion(forwardChar)),
      'Ctrl-b': bind(motion(backwardChar)),
      'Alt-f': bind(motion(forwardWord)),
      'Alt-b': bind(motion(backwardWord)),
      'Ctrl-a': bind(motion(lineStart)),
      'Ctrl-e': bind(motion(lineEnd)),
      'Ctrl-n': bind(lineMove(1)),
      'Ctrl-p': bind(lineMove(-1)),
      'Alt-<': bind(motion(documentStart)),
      'Alt->': bind(motion(documentEnd)),
      // macOS reports Option+Shift+, as a symbol; ProseMirror matches it by the physical key.
      'Alt-Shift-,': bind(motion(documentStart)),
      'Alt-Shift-.': bind(motion(documentEnd)),
      'Ctrl-d': bind(deleteChar),
      'Ctrl-k': bind(killLine),
      'Alt-d': bind(killWord),
      'Ctrl-w': bind(killRegion),
      'Alt-w': bind(copyRegion),
      'Ctrl-y': bind(yank),
      'Alt-y': bind(yankPop),
      'Ctrl-Space': bind(setMark),
      'Ctrl-g': bind(keyboardQuit),
      'Ctrl-/': bind(undoLocal),
      'Ctrl-_': bind(undoLocal),
      'Ctrl-?': bind(redoLocal),
    };
  },
});
