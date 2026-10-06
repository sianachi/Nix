import { nixEditingExtensions } from '@nix/editor-schema';
import { Editor, Extension } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EmacsKeymap, emacsKillRing } from '../../editor/emacs-keymap';
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

function openEmacs(content: string): Editor {
  const opened = new Editor({
    element: document.createElement('div'),
    extensions: [...nixEditingExtensions, EmacsKeymap],
    content,
  });
  editor = opened;
  return opened;
}

const alt = { ctrlKey: false, altKey: true } as const;

function blocks(): string[] {
  const texts: string[] = [];
  editor?.state.doc.descendants((node) => {
    if (!node.isTextblock) return true;
    texts.push(node.textContent);
    return false;
  });
  return texts;
}

function at(pos: number): void {
  editor?.commands.setTextSelection(pos);
}

function selection(): { from: number; to: number } {
  if (editor === null) throw new Error('The editor is not open.');
  return { from: editor.state.selection.from, to: editor.state.selection.to };
}

describe('Emacs basics movement', () => {
  it('moves by character with Ctrl+F/B, crossing into the next and previous block', () => {
    openEmacs('<p>ab</p><p>cd</p>');
    at(2);

    expect(key('f').defaultPrevented).toBe(true);
    expect(selection().from).toBe(3);
    key('f');
    expect(selection().from).toBe(5);
    key('b');
    expect(selection().from).toBe(3);
    key('b');
    expect(selection().from).toBe(2);
  });

  it('moves by whole graphemes', () => {
    openEmacs(`<p>A\u{1F469}\u200D\u{1F4BB}Z</p>`);
    at(2);

    key('f');
    expect(selection().from).toBe(7);
    key('b');
    expect(selection().from).toBe(2);
  });

  it('moves to word ends with Alt+F and word starts with Alt+B, across blocks', () => {
    openEmacs('<p>alpha beta</p><p>gamma</p>');
    at(1);

    key('f', alt);
    expect(selection().from).toBe(6);
    key('f', alt);
    expect(selection().from).toBe(11);
    key('f', alt);
    expect(selection().from).toBe(18);
    key('b', alt);
    expect(selection().from).toBe(13);
    key('b', alt);
    expect(selection().from).toBe(7);
  });

  it('moves by line with Ctrl+N/P, keeping the column, where no layout is available', () => {
    openEmacs('<p>alpha</p><p>beta</p><p>c</p>');
    at(4);

    key('n');
    expect(selection().from).toBe(11);
    key('n');
    // "c" is shorter; the caret stops at its end.
    expect(selection().from).toBe(15);
    key('p');
    expect(selection().from).toBe(9);
  });

  it('goes to either end of the note with Alt+< and Alt+>', () => {
    openEmacs('<p>first</p><p>last</p>');
    at(3);

    key('>', { ...alt, shiftKey: true });
    expect(selection().from).toBe(12);
    key('<', { ...alt, shiftKey: true });
    expect(selection().from).toBe(1);
  });
});

describe('Emacs basics mark and region', () => {
  it('extends a region from the mark, and Ctrl+G clears it', () => {
    openEmacs('<p>alpha beta</p>');
    at(1);

    key(' ');
    key('f', alt);
    expect(selection()).toEqual({ from: 1, to: 6 });
    key('e');
    expect(selection()).toEqual({ from: 1, to: 11 });

    key('g');
    expect(selection()).toEqual({ from: 11, to: 11 });
    key('b');
    expect(selection()).toEqual({ from: 10, to: 10 });
  });

  it('deactivates the mark on a second Ctrl+Space and on any edit', () => {
    openEmacs('<p>alpha beta</p>');
    at(1);
    key(' ');
    key(' ');
    key('f');
    expect(selection()).toEqual({ from: 2, to: 2 });

    key(' ');
    editor?.commands.insertContent('X');
    key('f');
    expect(selection().from).toBe(selection().to);
  });

  it('kills the region with Ctrl+W and copies it with Alt+W', () => {
    openEmacs('<p>alpha beta</p>');
    at(1);
    key(' ');
    key('f', alt);
    key('w', alt);
    expect(blocks()).toEqual(['alpha beta']);
    expect(selection()).toEqual({ from: 6, to: 6 });
    expect(emacsKillRing()[0]?.content.textBetween(0, emacsKillRing()[0]?.content.size ?? 0)).toBe(
      'alpha',
    );

    at(7);
    key(' ');
    key('e');
    key('w');
    expect(blocks()).toEqual(['alpha ']);
    key('y');
    expect(blocks()).toEqual(['alpha beta']);
  });
});

describe('Emacs basics kill ring', () => {
  it('kills the rest of the line, then the break, and yanks both back as one entry', () => {
    openEmacs('<p>alpha beta</p><p>next</p><p>after</p>');
    at(7);

    key('k');
    expect(blocks()).toEqual(['alpha ', 'next', 'after']);
    key('k');
    expect(blocks()).toEqual(['alpha next', 'after']);
    key('k');
    expect(blocks()).toEqual(['alpha ', 'after']);

    key('y');
    expect(blocks()).toEqual(['alpha beta', 'next', 'after']);
  });

  it('starts a new entry when something else happened between kills', () => {
    openEmacs('<p>one two</p>');
    const before = emacsKillRing().length;
    at(5);
    key('k');
    key('b');
    key('b');
    key('k');

    expect(emacsKillRing().length).toBe(before + 2);
    expect(blocks()).toEqual(['on']);
  });

  it('kills a word forward with Alt+D', () => {
    openEmacs('<p>alpha beta gamma</p>');
    at(6);

    key('d', alt);
    expect(blocks()).toEqual(['alpha gamma']);
  });

  it('swaps a yank for the previous kill with Alt+Y', () => {
    openEmacs('<p>one</p><p>two</p><p></p>');
    at(1);
    key('k');
    at(3);
    key('k');
    key('n');
    key('y');
    expect(blocks()).toEqual(['', '', 'two']);

    key('y', alt);
    expect(blocks()).toEqual(['', '', 'one']);
    key('y', alt);
    expect(blocks()[2]).not.toBe('one');
  });

  it('keeps formatting through a kill and a yank', () => {
    openEmacs('<p><strong>bold</strong> plain</p><p></p>');
    at(1);
    key('k');
    key('n');
    key('y');

    const yanked = editor?.state.doc.child(1).firstChild;
    expect(yanked?.text).toBe('bold');
    expect(yanked?.marks.map((mark) => mark.type.name)).toEqual(['bold']);
  });

  it('deletes forward with Ctrl+D without touching the kill ring, joining at a block end', () => {
    openEmacs('<p>ab</p><p>cd</p>');
    const ring = emacsKillRing().length;
    at(1);

    key('d');
    expect(blocks()).toEqual(['b', 'cd']);
    key('e');
    key('d');
    expect(blocks()).toEqual(['bcd']);
    expect(emacsKillRing().length).toBe(ring);
  });

  it('leaves a read-only note to the browser', () => {
    openEmacs('<p>alpha beta</p>');
    editor?.setEditable(false);
    at(1);

    expect(key('k').defaultPrevented).toBe(false);
    expect(key('d').defaultPrevented).toBe(false);
    expect(blocks()).toEqual(['alpha beta']);
  });
});
