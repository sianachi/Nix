import { nixEditingExtensions } from '@nix/editor-schema';
import { Editor, Extension } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EmacsKeymap } from '../../editor/emacs-keymap';
import { useKeyboardModeStore } from '../../editor/keyboard-mode-store';

let editor: Editor | null = null;

function key(keyValue: string, options: KeyboardEventInit = {}): KeyboardEvent {
  if (editor === null) {
    throw new Error('The editor is not open.');
  }
  const event = new KeyboardEvent('keydown', {
    key: keyValue,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  editor.view.dom.dispatchEvent(event);
  return event;
}

function textStart(label: string): number {
  if (editor === null) {
    throw new Error('The editor is not open.');
  }
  const matches: number[] = [];
  editor.state.doc.descendants((node, position) => {
    if (node.isText && node.text === label) {
      matches.push(position);
    }
  });
  const found = matches[0];
  if (found === undefined) {
    throw new Error(`The editor does not contain "${label}".`);
  }
  return found;
}

beforeEach(() => {
  useKeyboardModeStore.setState({ mode: 'emacs', persistence: 'stored' });
});

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe('Emacs basics', () => {
  it('moves to the start and end of the current rich-text block', () => {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [...nixEditingExtensions, EmacsKeymap],
      content: '<h2>Heading</h2><p>Second block</p>',
    });
    // The second paragraph starts after the heading's opening token, text and closing token.
    editor.commands.setTextSelection(12);

    expect(key('a').defaultPrevented).toBe(true);
    expect(editor.state.selection.from).toBe(10);

    expect(key('e').defaultPrevented).toBe(true);
    expect(editor.state.selection.from).toBe(22);
  });

  it('claims a supported key even when the caret is already at the boundary', () => {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [...nixEditingExtensions, EmacsKeymap],
      content: '<p>Text</p>',
    });
    editor.commands.setTextSelection(1);

    expect(key('a').defaultPrevented).toBe(true);
    expect(editor.state.selection.from).toBe(1);
  });

  it('keeps movement inside list, table, toggle, and column text blocks', () => {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [...nixEditingExtensions, EmacsKeymap],
      content: {
        type: 'doc',
        content: [
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'List text' }] }],
              },
            ],
          },
          {
            type: 'table',
            content: [
              {
                type: 'tableRow',
                content: [
                  {
                    type: 'tableCell',
                    attrs: { colspan: 1, rowspan: 1, colwidth: null, align: null },
                    content: [
                      { type: 'paragraph', content: [{ type: 'text', text: 'Cell text' }] },
                    ],
                  },
                ],
              },
            ],
          },
          {
            type: 'details',
            attrs: { toggleLevel: null },
            content: [
              { type: 'detailsSummary', content: [{ type: 'text', text: 'Summary' }] },
              {
                type: 'detailsContent',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Toggle text' }] }],
              },
            ],
          },
          {
            type: 'columnBlock',
            content: [
              {
                type: 'column',
                attrs: { width: null },
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Column text' }] }],
              },
              {
                type: 'column',
                attrs: { width: null },
                content: [{ type: 'paragraph' }],
              },
            ],
          },
        ],
      },
    });
    const before = editor.getJSON();

    for (const label of ['List text', 'Cell text', 'Toggle text', 'Column text']) {
      const start = textStart(label);
      editor.commands.setTextSelection(start + 1);
      key('a');
      expect(editor.state.selection.from).toBe(start);
      key('e');
      expect(editor.state.selection.from).toBe(start + label.length);
    }
    expect(editor.getJSON()).toEqual(before);
  });

  it('falls through immediately in Standard mode', () => {
    const competing = vi.fn(() => true);
    const BaseKeymap = Extension.create({
      name: 'baseKeymapProbe',
      priority: 1000,
      addKeyboardShortcuts() {
        return { 'Ctrl-a': competing };
      },
    });
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [...nixEditingExtensions, EmacsKeymap, BaseKeymap],
      content: '<p>Text</p>',
    });
    useKeyboardModeStore.setState({ mode: 'standard' });

    key('a');

    expect(competing).toHaveBeenCalledOnce();
  });

  it('responds to a live preference change without recreating the editor', () => {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [...nixEditingExtensions, EmacsKeymap],
      content: '<p>Text</p>',
    });
    const original = editor;
    useKeyboardModeStore.setState({ mode: 'standard' });
    expect(key('/').defaultPrevented).toBe(false);

    useKeyboardModeStore.setState({ mode: 'emacs' });
    expect(key('/').defaultPrevented).toBe(true);
    expect(editor).toBe(original);
  });

  it('leaves every supported chord alone while text is being composed', () => {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [...nixEditingExtensions, EmacsKeymap],
      content: '<p>Composed text</p>',
    });
    editor.commands.setTextSelection(5);
    const before = editor.getJSON();
    editor.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));

    for (const [keyValue, shiftKey] of [
      ['a', false],
      ['e', false],
      ['/', false],
      ['_', true],
    ] as const) {
      expect(key(keyValue, { shiftKey }).defaultPrevented).toBe(false);
    }

    expect(editor.state.selection.from).toBe(5);
    expect(editor.getJSON()).toEqual(before);
    editor.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  });
});
