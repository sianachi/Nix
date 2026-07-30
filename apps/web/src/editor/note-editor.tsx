import { nixExtensions } from '@nix/editor-schema';
import { Icon } from '@nix/ui';
import { mergeAttributes } from '@tiptap/core';
import { BubbleMenu } from '@tiptap/extension-bubble-menu';
import { Dropcursor, Gapcursor } from '@tiptap/extensions';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Plugin } from '@tiptap/pm/state';
import { redo, undo, yUndoPlugin, ySyncPlugin } from 'y-prosemirror';
import * as Y from 'yjs';

import { useAuth } from '../auth/auth-provider';
import { EditorToolbar } from './toolbar';
import { FRAGMENT_NAME, startCollabSync, type SyncState } from './collab-sync';
import { calloutClass, headingClass, proseClasses, proseRoot } from './prose';
import { filterSlashCommands, type SlashCommand } from './slash-menu';

/**
 * The note body: a TipTap editor over a Yjs document, synchronised through the collaboration
 * service.
 *
 * **Undo is the Yjs-aware history, not ProseMirror's.** With a shared document, ProseMirror's
 * default history would undo whatever happened last - including a colleague's edit - which is the
 * single most alarming thing a collaborative editor can do. `yUndoPlugin` undoes only your own.
 *
 * **The document is the schema package's**, not this file's. The collaboration service validates
 * every accepted update against the same definition, so a block that renders here is a block that
 * stores, and there is no way for the two to disagree.
 *
 * The editor is keyed on the item by its caller, so switching notes builds a new Yjs document
 * rather than reusing one - the failure that would otherwise carry one note's text into another.
 */

export interface NoteEditorProps {
  readonly itemId: string;
}

/**
 * The schema's extensions, each carrying the class its nodes render with.
 *
 * **Why the classes are attached here rather than in the schema package.** The collaboration
 * service builds the same schema in Node to check that an accepted update still parses, and it has
 * no business knowing what a blockquote looks like. Keeping presentation on this side is what lets
 * one definition of the document serve both, which is the whole reason that package exists.
 *
 * **Why per-extension configuration rather than a stylesheet.** ProseMirror renders the document
 * itself, so React never sees the nodes and cannot put a className on them - and the repository
 * permits no stylesheet to hang selectors off. TipTap's own `HTMLAttributes` is the seam that
 * remains, and it is the supported one.
 *
 * Heading and callout are configured through `renderHTML` instead, because their class depends on
 * an attribute - the level, the tone - which a fixed string cannot express.
 */
/**
 * What TipTap hands a node's renderer.
 *
 * Named here because `extend` widens its argument to `any`, and the two renderers below read an
 * attribute off the node - which is exactly the place an untyped argument would let a typo through
 * silently.
 */
interface RenderArgs {
  // Narrowed to the two attributes these renderers read, rather than an open bag: a typo in an
  // attribute name is otherwise an `unknown` that stringifies to "[object Object]" in a class name
  // and produces an element styled as nothing at all.
  readonly node: { readonly attrs: { readonly level?: unknown; readonly tone?: unknown } };
  readonly HTMLAttributes: Record<string, unknown>;
}

const styledExtensions = nixExtensions.map((extension) => {
  if (extension.name === 'heading') {
    return extension.extend({
      renderHTML({ node, HTMLAttributes }: RenderArgs) {
        const level = Number(node.attrs.level ?? 1);
        return [
          `h${String(level === 2 || level === 3 ? level : 1)}`,
          mergeAttributes(HTMLAttributes, { class: headingClass(level) }),
          0,
        ];
      },
    });
  }

  if (extension.name === 'callout') {
    return extension.extend({
      renderHTML({ node, HTMLAttributes }: RenderArgs) {
        const tone = typeof node.attrs.tone === 'string' ? node.attrs.tone : 'note';
        return [
          'aside',
          mergeAttributes(HTMLAttributes, { 'data-callout': '', class: calloutClass(tone) }),
          0,
        ];
      },
    });
  }

  const className = proseClasses[extension.name];
  return className === undefined
    ? extension
    : extension.configure({ HTMLAttributes: { class: className } });
});

export function NoteEditor({ itemId }: NoteEditorProps): ReactNode {
  const { getAccessToken } = useAuth();
  const [syncState, setSyncState] = useState<SyncState>('connecting');

  // One document per item, created once. Rebuilding it on a render would discard everything typed
  // since the last one.
  const doc = useMemo(() => new Y.Doc(), []);
  const fragment = useMemo(() => doc.getXmlFragment(FRAGMENT_NAME), [doc]);

  const editor = useEditor(
    {
      extensions: [
        ...styledExtensions,

        // Editing behaviour, added here rather than in the schema package: the collaboration
        // service builds the same schema in Node and has no use for a gap cursor.
        Gapcursor,
        Dropcursor,
        BubbleMenu.configure({ element: null }),
      ],

      // No `content`: the Yjs document is the source of truth, and seeding content here would
      // insert it again on every client that opened the note.
      editorProps: {
        attributes: {
          class: `${proseRoot} min-h-full outline-none`,
          'aria-label': 'Note body',
        },
      },

      onCreate: ({ editor: created }) => {
        // y-prosemirror ships untyped plugin factories, so the casts are the boundary between its
        // JavaScript and this file's types rather than a shortcut around them.
        created.registerPlugin(ySyncPlugin(fragment) as Plugin);
        created.registerPlugin(yUndoPlugin() as Plugin);
      },
    },
    [fragment],
  );

  useEffect(() => {
    const sync = startCollabSync({
      itemId,
      doc,
      fragmentName: FRAGMENT_NAME,
      getAccessToken,
      onState: setSyncState,
    });

    return () => {
      sync.destroy();
    };
  }, [doc, getAccessToken, itemId]);

  useEffect(() => {
    return () => {
      doc.destroy();
    };
  }, [doc]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <EditorToolbar
        editor={editor}
        // The Yjs history, so undo reverts your own edits and never a colleague's. Passed in
        // rather than imported by the toolbar, which has no business knowing the document is a
        // CRDT.
        onUndo={() => {
          undo(editor.state);
        }}
        onRedo={() => {
          redo(editor.state);
        }}
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        <SlashMenu editor={editor} />
        <EditorContent editor={editor} className="h-full" />
      </div>

      <SaveState state={syncState} />
    </div>
  );
}

/**
 * The connection state, said in the terms a writer actually needs.
 *
 * Six states, none of them a spinner standing in for the others. "Live" means edits are
 * streaming to everyone now; "pending" means edits exist here that the server does not
 * have yet; "read-only" and "at capacity" are the server's own words, relayed rather than
 * hidden - and every disconnected state says your work is safe locally, because with a
 * CRDT it genuinely is.
 */
function SaveState({ state }: { readonly state: SyncState }): ReactNode {
  const message =
    state === 'live'
      ? 'Live. Edits reach other people as you type.'
      : state === 'pending'
        ? 'Saving locally. Your edits will sync when the connection returns.'
        : state === 'connecting'
          ? 'Connecting…'
          : state === 'readonly'
            ? 'Read-only. Your access to this document changed, so edits are not accepted.'
            : state === 'degraded'
              ? 'The server cannot take this document right now. Your edits are kept here; retrying, and reloading may help.'
              : 'Offline. Your edits are kept here and will be sent when the connection returns.';

  return (
    <footer
      // Polite rather than assertive: the state changes on a timer, and an assertive region would
      // interrupt a screen-reader user mid-sentence every time it did.
      aria-live="polite"
      className="border-t border-divider px-8 py-2 text-xs text-muted"
    >
      {message}
    </footer>
  );
}

/**
 * The block inserter, opened with `/`.
 *
 * Filtering happens as you type, and the list is flat because a menu you filter beats a menu you
 * navigate. Escape closes it without inserting anything, which is what a person who typed `/` in
 * the middle of a sentence needs.
 */
function SlashMenu({ editor }: { readonly editor: Editor }): ReactNode {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const filterRef = useRef<HTMLInputElement>(null);

  // Focus moved deliberately rather than declared with autoFocus: the menu appears in response to
  // a keystroke, so moving the caret into it is continuing what the person started - which is the
  // one case where taking focus is right, and the attribute cannot express the distinction.
  useEffect(() => {
    if (open) {
      filterRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape' && open) {
        setOpen(false);
        setQuery('');
        return;
      }

      if (event.key === '/' && editor.isFocused && !open) {
        setOpen(true);
        setQuery('');
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [editor, open]);

  const commands = filterSlashCommands(query);

  function insert(command: SlashCommand): void {
    // The `/` and whatever was typed after it are the menu's, not the document's, so they come
    // back out before the block goes in.
    const { from } = editor.state.selection;
    const start = Math.max(0, from - (query.length + 1));
    editor.chain().focus().deleteRange({ from: start, to: from }).run();

    command.run(editor);
    setOpen(false);
    setQuery('');
  }

  if (!open) {
    return null;
  }

  return (
    <div
      role="listbox"
      aria-label="Insert a block"
      className="absolute z-20 mt-1 max-h-[280px] w-[280px] overflow-y-auto border border-divider bg-background shadow-md"
    >
      <input
        aria-label="Filter blocks"
        ref={filterRef}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
        }}
        className="w-full border-b border-divider bg-transparent px-3 py-2 text-base outline-none"
        placeholder="Filter blocks"
      />

      {commands.length === 0 ? (
        <p className="px-3 py-2 text-sm text-muted">No block matches.</p>
      ) : (
        commands.map((command) => (
          <button
            key={command.id}
            type="button"
            role="option"
            aria-selected={false}
            onClick={() => {
              insert(command);
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-base hover:bg-accent/10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
          >
            <Icon icon={command.icon} size="sm" />
            <span className="flex-1 truncate">{command.label}</span>
            <span className="text-xs text-muted">{command.hint}</span>
          </button>
        ))
      )}
    </div>
  );
}
