import { nixExtensions } from '@nix/editor-schema';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type ReactNode } from 'react';

import {
  SLASH_COMMANDS,
  filterSlashCommands,
  findSlashTrigger,
  SlashMenu,
} from '../../editor/slash-menu';

describe('the slash menu', () => {
  it('offers every block the schema defines a way to insert', () => {
    const ids = SLASH_COMMANDS.map((command) => command.id);

    // A block in the schema with no way to insert it is a block nobody can use. Tables and
    // callouts are here because they are exactly the two a thin first cut always omits.
    expect(ids).toEqual(
      expect.arrayContaining([
        'paragraph',
        'heading-1',
        'heading-2',
        'heading-3',
        'bullet-list',
        'ordered-list',
        'task-list',
        'blockquote',
        'code-block',
        'callout',
        'divider',
        'table',
        'image',
        'link-item',
      ]),
    );
  });

  it('shows everything when nothing has been typed', () => {
    expect(filterSlashCommands('')).toHaveLength(SLASH_COMMANDS.length);
    expect(filterSlashCommands('   ')).toHaveLength(SLASH_COMMANDS.length);
  });

  it('matches on the label', () => {
    expect(filterSlashCommands('table').map((command) => command.id)).toEqual(['table']);
  });

  it('matches on the words people actually reach for', () => {
    // "bullet", "ul" and "list" all have to find the same thing: people type the word they know,
    // not the word the schema uses.
    for (const query of ['bullet', 'ul', 'unordered']) {
      expect(filterSlashCommands(query).map((command) => command.id)).toContain('bullet-list');
    }

    expect(filterSlashCommands('todo').map((command) => command.id)).toContain('task-list');
    expect(filterSlashCommands('admonition').map((command) => command.id)).toContain('callout');

    // The words somebody who wants a wiki link reaches for, "backlink" included: the panel that
    // surfaces them is the reason many people go looking for the command.
    for (const query of ['link', 'reference', 'backlink', 'wiki']) {
      expect(filterSlashCommands(query).map((command) => command.id)).toContain('link-item');
    }
  });

  it('ignores case and surrounding space', () => {
    expect(filterSlashCommands('  TABLE ').map((command) => command.id)).toEqual(['table']);
  });

  it('matches the whole of what was typed, first character included', () => {
    // The label arm used to drop the needle's first character - a leftover from when the query
    // still carried the `/` that opened the menu. Every correct match still matched, which is why
    // it survived unnoticed; what it also did was match things it should not.
    //
    // "zable" is the query that tells the two apart. Its tail is a real label, so the old arm
    // found "Table"; nothing in the list contains the whole of it, so the fixed arm finds nothing.
    // "able" would not have shown it, because that one is a genuine substring of the *keyword*
    // "table" and matches on the keywords arm either way.
    expect(filterSlashCommands('zable')).toEqual([]);
    expect(filterSlashCommands('table').map((command) => command.id)).toEqual(['table']);
  });

  it('returns nothing when nothing matches', () => {
    expect(filterSlashCommands('spreadsheet')).toEqual([]);
  });
});

describe('finding an open slash trigger', () => {
  it('opens at the start of a block', () => {
    expect(findSlashTrigger('/')).toEqual({ start: 0, query: '' });
  });

  it('opens after whitespace and carries what was typed', () => {
    expect(findSlashTrigger('say /tab')).toEqual({ start: 4, query: 'tab' });
  });

  it('allows spaces in the query, because the labels have them', () => {
    expect(findSlashTrigger('/task l')).toEqual({ start: 0, query: 'task l' });
  });

  it('stays closed mid-word, so "and/or" and URLs stay prose', () => {
    expect(findSlashTrigger('and/or')).toBeNull();
    expect(findSlashTrigger('https://example')).toBeNull();
  });

  it('stays closed at the edge of a truncated window, where the preceding character is unknown', () => {
    expect(findSlashTrigger('/x', true)).toBeNull();
  });

  it('closes when a second slash makes it a path', () => {
    // The second slash re-anchors the search and then fails the word-start test.
    expect(findSlashTrigger('see /a/b')).toBeNull();
  });

  it('closes on a newline', () => {
    expect(findSlashTrigger('/head\nmore')).toBeNull();
  });

  it('closes past the length any command name could have', () => {
    expect(findSlashTrigger(`/${'x'.repeat(25)}`)).toBeNull();
  });
});

/**
 * The menu against a real editor: the trigger read out of the document, the keyboard driven
 * through the editor's own element, and the commit against real positions.
 *
 * These exist because the previous design's bugs were exactly interaction bugs - a menu that
 * opened showing "No block matches" until a backspace, and arrow keys that moved nothing - and
 * the pure-function tests above cannot see either.
 */

let captured: Editor | null = null;

function Harness(): ReactNode {
  const editor = useEditor({
    extensions: [...nixExtensions],
    onCreate: ({ editor: created }) => {
      captured = created;
    },
  });

  return (
    <>
      <SlashMenu editor={editor} />
      <EditorContent editor={editor} />
    </>
  );
}

beforeEach(() => {
  captured = null;
});

/** Renders the harness and types `content` into the document as one insertion. */
async function openWith(content: string): Promise<Editor> {
  render(<Harness />);

  await waitFor(() => {
    expect(captured).not.toBeNull();
  });

  const editor = captured;
  if (editor === null) {
    throw new Error('The editor never reported itself created.');
  }

  // jsdom performs no layout, so the caret has no coordinates to measure. The menu only uses
  // them to position its floating box, which these tests do not assert on.
  vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue({
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
  });

  act(() => {
    editor.commands.insertContent(content);
  });

  return editor;
}

describe('the slash menu over a real document', () => {
  it('opens on a slash typed at the start of a block, with every command on offer', async () => {
    await openWith('/');

    const listbox = await screen.findByRole('listbox', { name: 'Insert a block' });
    expect(listbox).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(SLASH_COMMANDS.length);
  });

  it('filters as the query is typed into the document', async () => {
    await openWith('/tab');

    const options = await screen.findAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('Table');
  });

  it('commits with the arrow keys and Enter, and removes the trigger text', async () => {
    const editor = await openWith('/');
    await screen.findByRole('listbox', { name: 'Insert a block' });

    // The keys go to the editor's element, because that is what holds the focus - there is no
    // field of the menu's own for them to go to.
    fireEvent.keyDown(editor.view.dom, { key: 'ArrowDown' });
    fireEvent.keyDown(editor.view.dom, { key: 'Enter' });

    // The second option is Heading 1, and the slash it was filtered by is gone.
    expect(editor.getHTML()).toContain('<h1');
    expect(editor.getText()).not.toContain('/');
  });

  it('inserts a reference trigger from the link command, which is what opens the item picker', async () => {
    const editor = await openWith('/link');
    await screen.findByRole('listbox', { name: 'Insert a block' });

    fireEvent.keyDown(editor.view.dom, { key: 'Enter' });

    // `[[` in the document is the reference picker's trigger; writing it is how this command
    // opens that picker rather than owning a picker of its own.
    expect(editor.getText()).toContain('[[');
    expect(editor.getText()).not.toContain('/link');
  });

  it('closes on Escape and leaves the typed slash where it was', async () => {
    const editor = await openWith('/');
    await screen.findByRole('listbox', { name: 'Insert a block' });

    fireEvent.keyDown(editor.view.dom, { key: 'Escape' });

    expect(screen.queryByRole('listbox', { name: 'Insert a block' })).not.toBeInTheDocument();
    // The `/` somebody typed is theirs; dismissing the menu must not edit the document.
    expect(editor.getText()).toContain('/');
  });

  it('does not open mid-word, so a URL can be typed in peace', async () => {
    await openWith('https://example');

    expect(screen.queryByRole('listbox', { name: 'Insert a block' })).not.toBeInTheDocument();
  });

  it('yields to the reference picker when the slash is inside an open link query', async () => {
    await openWith('[[ledger /q');

    // Two floating menus over one caret would fight for the same arrow keys; the more specific
    // trigger wins.
    expect(screen.queryByRole('listbox', { name: 'Insert a block' })).not.toBeInTheDocument();
  });
});
