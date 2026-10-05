import { Extension } from '@tiptap/core';
import { selectTextblockEnd, selectTextblockStart } from '@tiptap/pm/commands';
import { undo } from 'y-prosemirror';

import { useKeyboardModeStore } from './keyboard-mode-store';

/**
 * The deliberately small Emacs preset advertised in Settings.
 *
 * These commands are stable in a rich document because they operate on ProseMirror text blocks,
 * not rendered lines or JavaScript string offsets. Prefixes, visual-line movement and kill/yank
 * are absent until their paired state and Unicode behavior can be implemented as one contract.
 */
export const EmacsKeymap = Extension.create({
  name: 'emacsKeymap',
  // Ctrl-A must beat the platform keymap's select-all on Windows and Linux.
  priority: 1100,

  addKeyboardShortcuts() {
    const enabled = (): boolean => useKeyboardModeStore.getState().mode === 'emacs';
    return {
      'Ctrl-a': () => {
        if (!enabled()) {
          return false;
        }
        selectTextblockStart(this.editor.state, this.editor.view.dispatch);
        return true;
      },
      'Ctrl-e': () => {
        if (!enabled()) {
          return false;
        }
        selectTextblockEnd(this.editor.state, this.editor.view.dispatch);
        return true;
      },
      'Ctrl-/': () => {
        if (!enabled()) {
          return false;
        }
        undo(this.editor.state);
        return true;
      },
      'Ctrl-_': () => {
        if (!enabled()) {
          return false;
        }
        undo(this.editor.state);
        return true;
      },
    };
  },
});
