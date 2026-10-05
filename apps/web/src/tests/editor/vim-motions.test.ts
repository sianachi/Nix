import { nixEditingExtensions } from '@nix/editor-schema';
import { Editor } from '@tiptap/core';
import { Gapcursor } from '@tiptap/extensions';
import { GapCursor } from '@tiptap/pm/gapcursor';
import { Slice } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  setVimEnabled,
  vimMode,
  vimMotionsKey,
  vimStatusMode,
  VimMotions,
} from '../../editor/vim-motions';

let editors: Editor[] = [];

function open(
  content = '<p>alpha beta gamma</p><p>last</p>',
  enabled = true,
  isApplePlatform?: boolean,
): Editor {
  const vimExtension =
    isApplePlatform === undefined ? VimMotions : VimMotions.configure({ isApplePlatform });
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [...nixEditingExtensions, Gapcursor, vimExtension],
    content,
  });
  editors.push(editor);
  if (enabled) {
    setVimEnabled(editor.view, true);
  }
  return editor;
}

function vimPlugin(editor: Editor) {
  const plugin = editor.state.plugins.find((candidate) => candidate.spec.key === vimMotionsKey);
  if (plugin === undefined) {
    throw new Error('The Vim motions plugin was not installed.');
  }
  return plugin;
}

function key(editor: Editor, keyValue: string, options: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: keyValue,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  editor.view.dom.dispatchEvent(event);
  return event;
}

afterEach(() => {
  for (const editor of editors) {
    editor.destroy();
  }
  editors = [];
});

describe('Vim basics Normal mode', () => {
  it('exposes no active mode until enabled and activates directly in Normal', () => {
    const editor = open('<p>Text</p>', false);

    expect(vimStatusMode(editor.state)).toBeNull();
    setVimEnabled(editor.view, true);
    expect(vimStatusMode(editor.state)).toBe('normal');
  });

  it('starts each editor in Normal and blocks unsupported editing without cancelling Tab or arrows', () => {
    const editor = open('<p>Text</p>');
    const before = editor.getJSON();

    expect(vimMode(editor.state)).toBe('normal');
    for (const keyValue of ['q', ' ', 'Backspace', 'Delete', 'Enter']) {
      expect(key(editor, keyValue).defaultPrevented).toBe(true);
    }
    expect(key(editor, 'Tab').defaultPrevented).toBe(false);
    expect(key(editor, 'ArrowRight').defaultPrevented).toBe(false);
    expect(editor.getJSON()).toEqual(before);
  });

  it('skips rich-editor Tab and modified destructive keymaps without cancelling native focus traversal', () => {
    const editor = open('<p>Text</p>');
    editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: false });
    const cells: number[] = [];
    editor.state.doc.descendants((node, position) => {
      if (node.type.name === 'tableCell') {
        cells.push(position);
      }
    });
    const lastCell = cells.at(-1);
    if (lastCell === undefined) {
      throw new Error('The table did not contain a cell.');
    }
    editor.commands.setTextSelection(lastCell + 2);
    const before = editor.getJSON();

    const tab = key(editor, 'Tab');
    for (const [keyValue, modifiers] of [
      ['Backspace', { ctrlKey: true }],
      ['Delete', { altKey: true }],
      ['Enter', { metaKey: true }],
    ] as const) {
      expect(key(editor, keyValue, modifiers).defaultPrevented).toBe(true);
    }

    expect(tab.defaultPrevented).toBe(false);
    expect(editor.getJSON()).toEqual(before);

    const listEditor = open('<ul><li><p>One</p></li><li><p>Two</p></li></ul>');
    let secondItemText: number | undefined;
    listEditor.state.doc.descendants((node, position) => {
      if (node.isTextblock && node.textContent === 'Two') {
        secondItemText = position + 1;
      }
    });
    if (secondItemText === undefined) {
      throw new Error('The list did not contain its second item.');
    }
    listEditor.commands.setTextSelection(secondItemText);
    const beforeListTab = listEditor.getJSON();

    const listTab = key(listEditor, 'Tab');

    expect(listTab.defaultPrevented).toBe(false);
    expect(listEditor.getJSON()).toEqual(beforeListTab);
  });

  it('skips code-block arrow keymaps while leaving native navigation uncancelled', () => {
    const editor = open('<pre><code>Code</code></pre>');
    const before = editor.getJSON();
    editor.commands.setTextSelection(1);

    const up = key(editor, 'ArrowUp');
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    const down = key(editor, 'ArrowDown');

    expect(up.defaultPrevented).toBe(false);
    expect(down.defaultPrevented).toBe(false);
    expect(editor.getJSON()).toEqual(before);
  });

  it.each([
    ['Ctrl+H', 'h', { ctrlKey: true }],
    ['Ctrl+D', 'd', { ctrlKey: true }],
    ['Alt+D', 'd', { altKey: true }],
  ] as const)('claims the macOS destructive alias %s', (_name, keyValue, modifiers) => {
    const editor = open('<p>Text</p>', true, true);
    editor.commands.setTextSelection(3);
    const before = editor.getJSON();

    const event = key(editor, keyValue, modifiers);

    expect(event.defaultPrevented).toBe(true);
    expect(editor.state.selection.from).toBe(3);
    expect(editor.getJSON()).toEqual(before);
  });

  it.each([
    ['Ctrl+H', 'h', { ctrlKey: true }],
    ['Ctrl+D', 'd', { ctrlKey: true }],
    ['Alt+D', 'd', { altKey: true }],
  ] as const)('leaves the non-Apple browser shortcut %s alone', (_name, keyValue, modifiers) => {
    const editor = open('<p>Text</p>', true, false);
    const plugin = vimPlugin(editor);
    const event = new KeyboardEvent('keydown', { key: keyValue, ...modifiers });

    expect(plugin.props.handleKeyDown?.call(plugin, editor.view, event)).toBe(false);
  });

  it('moves by character, word, text-block edge, and document edge', () => {
    const editor = open();
    editor.commands.setTextSelection(3);

    key(editor, 'h');
    expect(editor.state.selection.from).toBe(2);
    key(editor, 'l');
    expect(editor.state.selection.from).toBe(3);
    key(editor, 'w');
    expect(editor.state.selection.from).toBe(7);
    key(editor, 'b');
    expect(editor.state.selection.from).toBe(1);
    key(editor, 'e');
    expect(editor.state.selection.from).toBe(6);
    key(editor, '$');
    expect(editor.state.selection.from).toBe(17);
    key(editor, '0');
    expect(editor.state.selection.from).toBe(1);
    key(editor, 'G');
    expect(editor.state.selection.from).toBe(23);
    key(editor, 'g');
    expect(editor.state.selection.from).toBe(23);
    key(editor, 'g');
    expect(editor.state.selection.from).toBe(1);
  });

  it('moves through a 100,000-character text block without expanding a segment array', () => {
    const text = `${'word '.repeat(20_000)}finish`;
    const editor = open(`<p>${text}</p>`);
    editor.commands.setTextSelection(text.length + 1);

    key(editor, 'b');

    expect(editor.state.selection.from).toBe(text.length - 'finish'.length + 1);
  });

  it('does not read a large text block for unsupported Normal keys', () => {
    const editor = open(`<p>${'word '.repeat(20_000)}</p>`);
    const textBetween = vi.spyOn(editor.state.selection.$head.parent, 'textBetween');

    key(editor, 'q');

    expect(textBetween).not.toHaveBeenCalled();
  });

  it('moves and appends only at whole Unicode grapheme boundaries', () => {
    const value = `A\u{1D11E}e\u0301\u{1F469}\u200D\u{1F4BB}Z`;
    const editor = open(`<p>${value}</p>`);
    editor.commands.setTextSelection(2);

    key(editor, 'l');
    expect(editor.state.selection.from).toBe(4);
    key(editor, 'l');
    expect(editor.state.selection.from).toBe(6);
    key(editor, 'l');
    expect(editor.state.selection.from).toBe(11);
    key(editor, 'h');
    expect(editor.state.selection.from).toBe(6);

    editor.commands.setTextSelection(2);
    key(editor, 'a');
    editor.commands.insertContent('X');
    expect(editor.getText()).toBe(`A\u{1D11E}Xe\u0301\u{1F469}\u200D\u{1F4BB}Z`);
  });

  it('treats w, b, and e as language-word motions within one text block', () => {
    const editor = open('<p>alpha...beta привет мир</p><p>next block</p>');
    editor.commands.setTextSelection(3);

    key(editor, 'w');
    expect(editor.state.selection.from).toBe(9);
    key(editor, 'w');
    expect(editor.state.selection.from).toBe(14);
    key(editor, 'e');
    expect(editor.state.selection.from).toBe(20);
    key(editor, 'b');
    expect(editor.state.selection.from).toBe(14);

    key(editor, '$');
    const endOfFirstBlock = editor.state.selection.from;
    key(editor, 'w');
    expect(editor.state.selection.from).toBe(endOfFirstBlock);
  });

  it('enters Insert at the caret, after it, and at either text-block edge', () => {
    const editor = open('<p>alpha</p>');
    editor.commands.setTextSelection(3);

    key(editor, 'i');
    expect(vimMode(editor.state)).toBe('insert');
    expect(editor.state.selection.from).toBe(3);
    key(editor, 'Escape');

    key(editor, 'a');
    expect(vimMode(editor.state)).toBe('insert');
    expect(editor.state.selection.from).toBe(4);
    key(editor, 'Escape');

    key(editor, 'I');
    expect(vimMode(editor.state)).toBe('insert');
    expect(editor.state.selection.from).toBe(1);
    key(editor, 'Escape');

    key(editor, 'A');
    expect(vimMode(editor.state)).toBe('insert');
    expect(editor.state.selection.from).toBe(6);
  });

  it('collapses ranges and rich selections before entering Insert', () => {
    const rangeEditor = open('<p>alpha beta</p>');
    rangeEditor.commands.setTextSelection({ from: 2, to: 7 });
    key(rangeEditor, 'i');
    expect(rangeEditor.state.selection).toBeInstanceOf(TextSelection);
    expect(rangeEditor.state.selection.empty).toBe(true);
    rangeEditor.commands.insertContent('X');
    expect(rangeEditor.getText().replace('X', '')).toBe('alpha beta');

    const tableEditor = open('<p>Before</p>');
    tableEditor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: false });
    const cells: number[] = [];
    tableEditor.state.doc.descendants((node, position) => {
      if (node.type.name === 'tableCell') {
        cells.push(position);
      }
    });
    const first = cells[0];
    const last = cells.at(-1);
    if (first === undefined || last === undefined) {
      throw new Error('The table did not contain enough cells.');
    }
    tableEditor.view.dispatch(
      tableEditor.state.tr.setSelection(CellSelection.create(tableEditor.state.doc, first, last)),
    );
    key(tableEditor, 'i');
    expect(tableEditor.state.selection).toBeInstanceOf(TextSelection);
    expect(tableEditor.state.selection.empty).toBe(true);
  });

  it('uses text carets for document edges and never selects edge images', () => {
    const editor = open(
      '<img src="https://images.example.test/start.png"><p>Text</p><img src="https://images.example.test/end.png">',
    );

    key(editor, 'G');
    expect(editor.state.selection).toBeInstanceOf(TextSelection);
    key(editor, 'i');
    editor.commands.insertContent('X');
    expect(editor.getJSON().content.filter((node) => node.type === 'image')).toHaveLength(2);
    key(editor, 'Escape');

    key(editor, 'g');
    key(editor, 'g');
    expect(editor.state.selection).toBeInstanceOf(TextSelection);
    key(editor, 'i');
    editor.commands.insertContent('Y');
    expect(editor.getJSON().content.filter((node) => node.type === 'image')).toHaveLength(2);
  });

  it.each(['i', 'a', 'I', 'A'])(
    'enters Insert with a safe gap after an atom-only note via %s',
    (keyValue) => {
      const editor = open('<img src="https://images.example.test/only.png">');

      key(editor, keyValue);

      expect(vimMode(editor.state)).toBe('insert');
      expect(editor.state.selection).toBeInstanceOf(GapCursor);
      editor.commands.insertContent('X');
      expect(editor.getJSON().content.filter((node) => node.type === 'image')).toHaveLength(1);
      expect(editor.getText()).toContain('X');
    },
  );

  it('marks every mode and motion transaction as selection-only and outside document history', () => {
    const editor = open();
    const transactions: { readonly docChanged: boolean; readonly addToHistory: unknown }[] = [];
    editor.on('transaction', ({ transaction }) => {
      transactions.push({
        docChanged: transaction.docChanged,
        addToHistory: transaction.getMeta('addToHistory') as unknown,
      });
    });

    for (const keyValue of ['l', 'w', '0', 'g', 'g', 'i', 'Escape']) {
      key(editor, keyValue);
    }

    expect(transactions.length).toBeGreaterThan(0);
    expect(transactions.every((transaction) => !transaction.docChanged)).toBe(true);
    expect(transactions.every((transaction) => transaction.addToHistory === false)).toBe(true);
  });

  it('blocks every external mutation entry in Normal but leaves Insert and internal moves unchanged', () => {
    const editor = open('<p>Text</p>');
    const plugin = vimPlugin(editor);
    const { props } = plugin;
    const normalInput = new InputEvent('beforeinput', {
      inputType: 'insertText',
      data: 'x',
      bubbles: true,
      cancelable: true,
    });
    const normalCut = new Event('cut', { bubbles: true, cancelable: true });
    editor.view.dom.dispatchEvent(normalInput);
    editor.view.dom.dispatchEvent(normalCut);
    expect(normalInput.defaultPrevented).toBe(true);
    expect(normalCut.defaultPrevented).toBe(true);
    expect(props.handleTextInput?.call(plugin, editor.view, 1, 1, 'x', () => editor.state.tr)).toBe(
      true,
    );
    expect(
      props.handlePaste?.call(
        plugin,
        editor.view,
        new Event('paste') as ClipboardEvent,
        Slice.empty,
      ),
    ).toBe(true);
    expect(
      props.handleDrop?.call(
        plugin,
        editor.view,
        new Event('drop') as DragEvent,
        Slice.empty,
        false,
      ),
    ).toBe(true);
    expect(
      props.handleDrop?.call(
        plugin,
        editor.view,
        new Event('drop') as DragEvent,
        Slice.empty,
        true,
      ),
    ).toBe(false);

    key(editor, 'i');
    const insertInput = new InputEvent('beforeinput', {
      inputType: 'insertText',
      data: 'x',
      bubbles: true,
      cancelable: true,
    });
    const insertCut = new Event('cut', { bubbles: true, cancelable: true });
    editor.view.dom.dispatchEvent(insertInput);
    editor.view.dom.dispatchEvent(insertCut);
    expect(insertInput.defaultPrevented).toBe(false);
    expect(insertCut.defaultPrevented).toBe(false);
    expect(props.handleTextInput?.call(plugin, editor.view, 1, 1, 'x', () => editor.state.tr)).toBe(
      false,
    );
    expect(
      props.handlePaste?.call(
        plugin,
        editor.view,
        new Event('paste') as ClipboardEvent,
        Slice.empty,
      ),
    ).toBe(false);
    expect(
      props.handleDrop?.call(
        plugin,
        editor.view,
        new Event('drop') as DragEvent,
        Slice.empty,
        false,
      ),
    ).toBe(false);
  });

  it('does not interpret Normal motions or Insert Escape while an IME composition is active', () => {
    const normalEditor = open('<p>Text</p>');
    normalEditor.commands.setTextSelection(3);
    normalEditor.view.dom.dispatchEvent(
      new CompositionEvent('compositionstart', { bubbles: true }),
    );

    expect(key(normalEditor, 'h').defaultPrevented).toBe(false);
    expect(vimMode(normalEditor.state)).toBe('normal');
    expect(normalEditor.state.selection.from).toBe(3);

    const insertEditor = open('<p>Text</p>');
    insertEditor.commands.setTextSelection(3);
    key(insertEditor, 'i');
    insertEditor.view.dom.dispatchEvent(
      new CompositionEvent('compositionstart', { bubbles: true }),
    );

    expect(key(insertEditor, 'Escape').defaultPrevented).toBe(false);
    expect(key(insertEditor, 'h').defaultPrevented).toBe(false);
    expect(vimMode(insertEditor.state)).toBe('insert');
    expect(insertEditor.state.selection.from).toBe(3);

    normalEditor.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    insertEditor.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  });

  it('keeps modal state independent in two editor panes', () => {
    const first = open('<p>First</p>');
    const second = open('<p>Second</p>');

    key(first, 'i');

    expect(vimMode(first.state)).toBe('insert');
    expect(vimMode(second.state)).toBe('normal');
  });

  it('falls through entirely when disabled', () => {
    const editor = open('<p>Text</p>');
    const before = editor.getJSON();
    setVimEnabled(editor.view, false);

    const event = key(editor, 'q');

    expect(event.defaultPrevented).toBe(false);
    expect(editor.getJSON()).toEqual(before);
  });

  it('does not claim modified application shortcuts', () => {
    const editor = open('<p>Text</p>');
    const event = key(editor, 'k', { ctrlKey: true });

    expect(event.defaultPrevented).toBe(false);
  });

  it('clears a pending g prefix on shortcuts, blur, and external selection changes', () => {
    const editor = open();
    editor.commands.setTextSelection(20);

    key(editor, 'g');
    key(editor, 'k', { ctrlKey: true });
    key(editor, 'g');
    expect(editor.state.selection.from).toBe(20);

    editor.view.dom.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    key(editor, 'g');
    expect(editor.state.selection.from).toBe(20);

    editor.commands.setTextSelection(21);
    key(editor, 'g');
    expect(editor.state.selection.from).toBe(21);
  });
});
