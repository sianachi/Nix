import { Extension } from '@tiptap/core';
import { GapCursor } from '@tiptap/pm/gapcursor';
import { Selection, TextSelection } from '@tiptap/pm/state';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

export type VimMode = 'normal' | 'insert';

interface VimMotionState {
  readonly enabled: boolean;
  readonly mode: VimMode;
  readonly pendingG: boolean;
}

interface VimMotionMeta {
  readonly enabled?: boolean;
  readonly mode?: VimMode;
  readonly pendingG?: boolean;
}

interface VimMotionsOptions {
  readonly isApplePlatform: boolean;
}

export const vimMotionsKey = new PluginKey<VimMotionState>('nixVimMotions');

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const navigatorPlatform: unknown = Reflect.get(navigator, 'platform');
const defaultIsApplePlatform =
  typeof navigatorPlatform === 'string' && /Mac|iP(hone|[oa]d)/.test(navigatorPlatform);

function readMeta(value: unknown): VimMotionMeta | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const enabled = 'enabled' in value ? value.enabled : undefined;
  const mode = 'mode' in value ? value.mode : undefined;
  const pendingG = 'pendingG' in value ? value.pendingG : undefined;
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    return null;
  }
  if (mode !== undefined && mode !== 'normal' && mode !== 'insert') {
    return null;
  }
  if (pendingG !== undefined && typeof pendingG !== 'boolean') {
    return null;
  }
  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(mode === undefined ? {} : { mode }),
    ...(pendingG === undefined ? {} : { pendingG }),
  };
}

function current(state: EditorState): VimMotionState {
  return vimMotionsKey.getState(state) ?? { enabled: false, mode: 'insert', pendingG: false };
}

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

function textCaret(view: EditorView): TextSelection | null {
  const { doc, selection } = view.state;
  if (selection instanceof TextSelection) {
    return TextSelection.create(doc, selection.head);
  }
  const found =
    Selection.findFrom(selection.$head, 1, true) ?? Selection.findFrom(selection.$head, -1, true);
  return found instanceof TextSelection ? TextSelection.create(doc, found.head) : null;
}

function documentCaret(view: EditorView, direction: 1 | -1): TextSelection | null {
  const edge = direction === 1 ? 0 : view.state.doc.content.size;
  const found = Selection.findFrom(view.state.doc.resolve(edge), direction, true);
  return found instanceof TextSelection ? found : null;
}

function insertCaret(view: EditorView): Selection | null {
  const caret = textCaret(view);
  if (caret !== null) {
    return caret;
  }
  return view.state.doc.childCount === 0
    ? null
    : new GapCursor(view.state.doc.resolve(view.state.doc.content.size));
}

function textblock(
  view: EditorView,
): { readonly caret: TextSelection; readonly text: string; readonly offset: number } | null {
  const caret = textCaret(view);
  if (!caret?.$head.parent.isTextblock) {
    return null;
  }
  return {
    caret,
    // One replacement character for an inline atom keeps string offsets aligned with document
    // positions without pretending the atom is a word.
    text: caret.$head.parent.textBetween(0, caret.$head.parent.content.size, '', '\uFFFC'),
    offset: caret.$head.parentOffset,
  };
}

function textblockSelection(
  view: EditorView,
  offset: number,
  caret = textCaret(view),
): TextSelection | null {
  if (!caret?.$head.parent.isTextblock) {
    return null;
  }
  const bounded = Math.max(0, Math.min(caret.$head.parent.content.size, offset));
  return TextSelection.create(view.state.doc, caret.$head.start() + bounded);
}

function wordMotion(view: EditorView, kind: 'next' | 'previous' | 'end'): Selection | null {
  const block = textblock(view);
  if (block === null) {
    return null;
  }
  let target: number | undefined;
  for (const segment of wordSegmenter.segment(block.text)) {
    if (segment.isWordLike !== true) {
      continue;
    }
    if (kind === 'next' && segment.index > block.offset) {
      target = segment.index;
      break;
    }
    if (kind === 'previous') {
      if (segment.index >= block.offset) {
        break;
      }
      target = segment.index;
    }
    if (kind === 'end' && segment.index + segment.segment.length > block.offset) {
      target = segment.index + segment.segment.length;
      break;
    }
  }
  return target === undefined ? null : textblockSelection(view, target, block.caret);
}

function graphemeMotion(view: EditorView, direction: 1 | -1): TextSelection | null {
  const block = textblock(view);
  if (block === null) {
    return null;
  }

  let target: number | undefined;
  for (const segment of graphemeSegmenter.segment(block.text)) {
    if (direction === -1) {
      if (segment.index >= block.offset) {
        break;
      }
      target = segment.index;
      continue;
    }
    const end = segment.index + segment.segment.length;
    if (end > block.offset) {
      target = end;
      break;
    }
  }
  return target === undefined ? null : textblockSelection(view, target, block.caret);
}

function move(view: EditorView, selection: Selection | null): void {
  dispatch(view, { pendingG: false }, selection ?? undefined);
}

function enterInsert(view: EditorView, selection: Selection | null = insertCaret(view)): void {
  const safeSelection = selection ?? insertCaret(view);
  if (safeSelection === null) {
    dispatch(view, { pendingG: false });
    return;
  }
  dispatch(view, { mode: 'insert', pendingG: false }, safeSelection);
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

function handleNormalKey(view: EditorView, event: KeyboardEvent): boolean {
  const state = current(view.state);
  if (state.pendingG && event.key !== 'g') {
    dispatch(view, { pendingG: false });
  }

  switch (event.key) {
    case 'h':
      move(view, graphemeMotion(view, -1));
      return true;
    case 'l':
      move(view, graphemeMotion(view, 1));
      return true;
    case 'w':
      move(view, wordMotion(view, 'next'));
      return true;
    case 'b':
      move(view, wordMotion(view, 'previous'));
      return true;
    case 'e':
      move(view, wordMotion(view, 'end'));
      return true;
    case '0':
      move(view, textblockSelection(view, 0));
      return true;
    case '$':
      move(view, textblockSelection(view, textCaret(view)?.$head.parent.content.size ?? 0));
      return true;
    case 'g':
      if (state.pendingG) {
        move(view, documentCaret(view, 1));
      } else {
        dispatch(view, { pendingG: true });
      }
      return true;
    case 'G':
      move(view, documentCaret(view, -1));
      return true;
    case 'i':
      enterInsert(view);
      return true;
    case 'a':
      enterInsert(view, graphemeMotion(view, 1));
      return true;
    case 'I':
      enterInsert(view, textblockSelection(view, 0));
      return true;
    case 'A':
      enterInsert(view, textblockSelection(view, textCaret(view)?.$head.parent.content.size ?? 0));
      return true;
    case 'Escape':
      dispatch(view, { pendingG: false });
      return true;
    case 'ArrowLeft':
    case 'ArrowRight':
    case 'ArrowUp':
    case 'ArrowDown':
    case 'Home':
    case 'End':
    case 'PageUp':
    case 'PageDown':
      return false;
    default:
      // Normal mode never inserts. Claim printable characters and destructive editing keys even
      // when they are not a supported motion; modified application shortcuts already returned.
      return (
        event.key.length === 1 ||
        event.key === 'Backspace' ||
        event.key === 'Delete' ||
        event.key === 'Enter'
      );
  }
}

function vimPlugin(isApplePlatform: boolean): Plugin<VimMotionState> {
  return new Plugin<VimMotionState>({
    key: vimMotionsKey,
    state: {
      init: () => ({
        enabled: false,
        mode: 'insert',
        pendingG: false,
      }),
      apply(transaction, value) {
        const raw: unknown = transaction.getMeta(vimMotionsKey);
        const meta = readMeta(raw);
        if (meta !== null) {
          return { ...value, ...meta };
        }
        return transaction.selectionSet && value.pendingG ? { ...value, pendingG: false } : value;
      },
    },
    props: {
      handleKeyDown(view, event) {
        if (
          !current(view.state).enabled ||
          event.isComposing ||
          view.composing ||
          isLegacyCompositionKey(event) ||
          !inTextControl(event)
        ) {
          return false;
        }
        const vim = current(view.state);
        if (vim.mode === 'insert') {
          if (event.key !== 'Escape') {
            return false;
          }
          dispatch(view, { mode: 'normal', pendingG: false });
          return true;
        }
        if (event.metaKey || event.ctrlKey || event.altKey) {
          if (vim.pendingG) {
            dispatch(view, { pendingG: false });
          }
          return isDestructiveShortcut(event, isApplePlatform);
        }
        return handleNormalKey(view, event);
      },
      handleTextInput(view) {
        const vim = current(view.state);
        return vim.enabled && vim.mode === 'normal';
      },
      handlePaste(view) {
        const vim = current(view.state);
        return vim.enabled && vim.mode === 'normal';
      },
      handleDrop(view, _event, _slice, moved) {
        const vim = current(view.state);
        return vim.enabled && vim.mode === 'normal' && !moved;
      },
      handleDOMEvents: {
        blur(view) {
          if (current(view.state).pendingG) {
            dispatch(view, { pendingG: false });
          }
          return false;
        },
        keydown(view, event) {
          const vim = current(view.state);
          // Returning true from a raw DOM handler skips ProseMirror's rich-node keymaps. Leaving
          // the event uncancelled preserves native focus traversal and caret navigation.
          return (
            vim.enabled &&
            vim.mode === 'normal' &&
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
          if (vim.enabled && vim.mode === 'normal' && inTextControl(event)) {
            event.preventDefault();
            return true;
          }
          return false;
        },
        beforeinput(view, event) {
          const vim = current(view.state);
          if (vim.enabled && vim.mode === 'normal' && inTextControl(event)) {
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

export function setVimEnabled(view: EditorView, enabled: boolean): void {
  const next: VimMode = enabled ? 'normal' : 'insert';
  const vim = current(view.state);
  if (vim.enabled !== enabled || vim.mode !== next || vim.pendingG) {
    dispatch(view, { enabled, mode: next, pendingG: false });
  }
}

/** A bounded modal preset: exact supported motions are disclosed in Settings. */
export const VimMotions = Extension.create<VimMotionsOptions>({
  name: 'vimMotions',
  priority: 900,
  addOptions() {
    return { isApplePlatform: defaultIsApplePlatform };
  },
  addProseMirrorPlugins() {
    return [vimPlugin(this.options.isApplePlatform)];
  },
});
