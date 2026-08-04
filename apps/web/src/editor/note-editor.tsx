import { nixExtensions } from '@nix/editor-schema';
import { mergeAttributes } from '@tiptap/core';
import { BubbleMenu } from '@tiptap/extension-bubble-menu';
import { Dropcursor, Gapcursor } from '@tiptap/extensions';
import { EditorContent, useEditor } from '@tiptap/react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Plugin } from '@tiptap/pm/state';
import { Awareness } from 'y-protocols/awareness';
import { redo, undo, yCursorPlugin, yUndoPlugin, ySyncPlugin } from 'y-prosemirror';
import * as Y from 'yjs';

import { useAuth } from '../auth/auth-provider';
import { useSessionStore } from '../auth/session-store';
import { EditorToolbar } from './toolbar';
import { FRAGMENT_NAME, startCollabSync, type SyncState } from './collab-sync';
import { PresenceList } from './presence-list';
import { SyncFooter } from './sync-footer';
import { calloutClass, headingClass, proseClasses, proseRoot } from './prose';
import { SlashMenu } from './slash-menu';

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
  // Narrowed to the attributes these renderers read, rather than an open bag: a typo in an
  // attribute name is otherwise an `unknown` that stringifies to "[object Object]" in a class name
  // and produces an element styled as nothing at all.
  readonly node: {
    readonly attrs: {
      readonly level?: unknown;
      readonly tone?: unknown;
      readonly width?: unknown;
    };
  };
  readonly HTMLAttributes: Record<string, unknown>;
}

/** What the details extension hands its toggle-button renderer. */
interface ToggleButtonArgs {
  readonly element: HTMLButtonElement;
  readonly isOpen: boolean;
  readonly node: { readonly firstChild: { readonly textContent: string | null } | null };
}

/**
 * The disclosure chevron, as an element rather than a React node.
 *
 * `renderToggleButton` is handed a raw DOM element by the extension, outside React's tree, so
 * `<Icon>` cannot be used here. The geometry is Lucide's `chevron-right` at the stroke width
 * the icon component uses, so it matches every other chevron in the product; taking the path
 * data rather than the component is what that constraint costs.
 */
function chevron(): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'size-4');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'm9 18 6-6-6-6');
  svg.append(path);

  return svg;
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

  if (extension.name === 'details') {
    return extension.configure({
      HTMLAttributes: { class: proseClasses.details },

      /**
       * The disclosure control.
       *
       * Configured here rather than in `@nix/editor-schema` for the same reason every class is:
       * the collaboration service builds the same node list in Node and has no icon library,
       * no DOM and no business knowing what a chevron looks like.
       *
       * Three things the vendor default gets wrong for this product. It draws no icon at all,
       * leaving the slot to be filled by a text glyph - which is what the icon rule exists to
       * prevent, and which would not match the Lucide chevrons used everywhere else in the
       * editor. It sets only `aria-label`, swapping the button's *name* between "Expand" and
       * "Collapse", so a screen reader hears a button that renames itself rather than a
       * disclosure that reports its state. And it names no section, so a document with six
       * toggles announces six identical buttons.
       */
      renderToggleButton: ({ element, isOpen, node }: ToggleButtonArgs) => {
        element.setAttribute('aria-expanded', String(isOpen));

        // A control inside a contenteditable region is part of the editable content, and
        // browsers do not reliably let Tab reach one. That matters more here than it looks: a
        // toggle starts closed and its body carries `hidden`, so a button nobody can focus
        // means content nobody can read without a pointer. Marking the button as its own
        // non-editable island is what restores the native button behaviour - focus, and Enter
        // or Space firing the click the extension already listens for.
        //
        // Set on every render rather than once; they are idempotent, and the extension calls
        // this again on each toggle.
        element.setAttribute('contenteditable', 'false');
        element.setAttribute('tabindex', '0');

        // The summary's own text, so the button says which section it opens. Falls back to a
        // generic word rather than an empty name, which would be announced as "button".
        const summary = node.firstChild?.textContent?.trim();
        element.setAttribute(
          'aria-label',
          `${isOpen ? 'Collapse' : 'Expand'} ${summary !== undefined && summary.length > 0 ? summary : 'section'}`,
        );

        element.replaceChildren(chevron());
      },
    });
  }

  if (extension.name === 'column') {
    return extension.extend({
      renderHTML({ node, HTMLAttributes }: RenderArgs) {
        // A width is a fraction of the row, so it becomes `flex-grow` - which no utility class
        // can express, because the set of fractions is not finite. `basis-0` and `flex-1` in
        // `proseRoot` are what make an unstated width an equal share; this only has to override
        // the grow factor when a column actually carries one.
        //
        // Written here rather than in `@nix/editor-schema` for the same reason every other
        // class is: the collaboration service builds the same node list in Node to check that
        // an update still parses, and it has no business knowing how wide a column looks.
        const width = Number(node.attrs.width);
        const style =
          Number.isFinite(width) && width > 0
            ? { style: `flex-grow: ${String(width)}` } // design-token-exempt: a column's share of its row is a runtime fraction, not a scale step - the same case as the sheet grid's column offsets.
            : {};

        return ['div', mergeAttributes(HTMLAttributes, { 'data-column': '' }, style), 0];
      },
    });
  }

  const className = proseClasses[extension.name];
  return className === undefined
    ? extension
    : extension.configure({ HTMLAttributes: { class: className } });
});

/**
 * Cursor colors, from the accent ramp and nothing else - but resolved to their values at
 * runtime, because y-prosemirror's cursor renderer accepts only literal six-digit colors
 * and cannot dereference a CSS variable.
 */
const CURSOR_COLOR_TOKENS = [
  '--color-accent-600',
  '--color-accent-2',
  '--color-accent-400',
  '--color-accent-700',
] as const;

function cursorColorFor(clientId: number): string {
  const token = CURSOR_COLOR_TOKENS[clientId % CURSOR_COLOR_TOKENS.length] ?? '--color-accent';
  const resolved = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return resolved.length > 0 ? resolved : '#5980a6'; // design-token-exempt: the accent token's own value, used only where no stylesheet is loaded at all (tests); the resolved token wins everywhere real.
}

/**
 * What the collaboration service can refuse, said in words a writer can act on.
 *
 * **Every one of these means the edit is not saved and no colleague will see it.** Without
 * this, the refusal is silent: the text stays on screen because the local CRDT accepted it,
 * the editor looks healthy, and the work is gone on reload. That failure is the reason
 * ADR-0024 made a client-visible story a precondition for the version-2 schema shipping.
 *
 * A code with no entry is deliberately not shown. These are the ones a person can do something
 * about; a transport hiccup that the reconnect already handles is noise.
 */
const REFUSAL_COPY: Readonly<Record<string, string>> = {
  document_above_schema_pin:
    'This note has not finished upgrading, so blocks added in this version cannot be saved to ' +
    'it yet. Everything else saves normally. Try again shortly.',
  schema_version_mismatch:
    'This note was written by a newer version of Nix than this one. Reload the page to catch up.',
  document_does_not_parse:
    'That change could not be saved: it would leave the note in a state Nix cannot reopen.',
  document_too_many_nodes:
    'This note has reached its size limit. Remove something before adding more.',
  document_too_large: 'This note has reached its size limit. Remove something before adding more.',
  // Deliberately not "pausing for a moment", which this said first: nothing pauses and nothing
  // resumes on its own. The update was refused, and what recovers it is the resync the server
  // sends immediately afterwards - so the honest thing is to name the delay, not promise a pause.
  rate_limited: 'That last change is taking a moment to save. It has not been lost.',
  read_only: 'You have read access to this note, so your changes are not being saved.',
};

/**
 * The origin for transactions that keep the document above the schema's floor.
 *
 * A symbol rather than an object, for the same reasons collab-sync's `REMOTE_ORIGIN` is one:
 * origins are compared by identity, a symbol names itself in a log, and Yjs's undo manager
 * falls back to matching `origin.constructor` - so a bare `{}` would start being tracked the
 * moment any tracked set gained `Object`. Its own origin, and not the sync plugin's, because
 * the undo manager tracks that plugin's origin: a restoration folded into the history being
 * unwound would be removed by the very next undo.
 */
const RESTORE_ORIGIN = Symbol('nix.editor.restore');

export function NoteEditor({ itemId }: NoteEditorProps): ReactNode {
  const { getAccessToken } = useAuth();
  const profile = useSessionStore((state) => state.profile);
  const [syncState, setSyncState] = useState<SyncState>('connecting');

  // What the server last refused, in words. Held rather than derived because a refusal is an
  // event: the document on screen still shows the edit, and the only honest thing to do is say
  // it did not stick.
  const [refusal, setRefusal] = useState<string | null>(null);

  // One document per item, created exactly once via useState's lazy initializer - unlike
  // useMemo, which is only a performance hint React is free to discard and recompute,
  // useState's initial value truly runs once per mount. Rebuilding the document on a render
  // would discard everything typed since the last one.
  const [doc] = useState(() => new Y.Doc());
  const fragment = useMemo(() => doc.getXmlFragment(FRAGMENT_NAME), [doc]);

  // Presence lives with the document, not the connection: the cursor plugin needs it at
  // plugin-registration time, before any socket exists, and it survives reconnects. Same
  // reasoning as `doc` above: constructed with useState so it is guaranteed to happen once.
  const [awareness] = useState(() => new Awareness(doc));

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
        // JavaScript and this file's types rather than a shortcut around them. The cursor plugin
        // registers with the sync plugin, and after it, because it reads that plugin's state.
        created.registerPlugin(ySyncPlugin(fragment) as Plugin);
        created.registerPlugin(yCursorPlugin(awareness) as Plugin);
        created.registerPlugin(yUndoPlugin() as Plugin);
      },
    },
    [fragment, awareness],
  );

  // The one document shape the schema refuses outright is an empty one - `doc` is `block+` -
  // and the Yjs undo manager can produce it. ProseMirror editing cannot: deleting everything
  // leaves one empty paragraph, because the schema's floor is enforced on every transaction.
  // But undo unwinds the *Yjs* history, below that floor, so undoing every edit you made on a
  // note you wrote returns the fragment to its pre-content state with no children at all.
  //
  // The sync binding does heal an emptied fragment, but a render cycle later - and what makes
  // that gap fatal is that collab-sync defers every send behind its flush timer, so a timer
  // firing (or a teardown flush) inside the gap sends the emptying update to the server alone.
  // The service refuses it as a document it could never reopen and forces a resync, which on
  // screen reads as an undo that silently did not take. Restoring the floor *synchronously*,
  // in the same transaction-cleanup pass, is what guarantees the restoration shares a flush
  // with the emptying: no send boundary can fall between two updates queued in one tick.
  //
  // Teardown needs no ordering care, and here is why, so nobody has to re-derive it: the
  // restoration is synchronous with the emptying, so by the time any unmount cleanup runs -
  // this observer detaching, or `sync.destroy()` flushing what is still pending - an emptying
  // that happened has already been answered, and the final flush carries both or neither.
  useEffect(() => {
    // The last paragraph this guard inserted, while it remains an empty placeholder. Held so
    // that when real content comes back - a redo restoring what the undo removed - the
    // placeholder does not linger as a blank block nobody authored and, being untracked by the
    // undo manager, no undo could ever remove.
    let restored: Y.XmlElement | null = null;

    const keepAboveTheFloor = (
      _events: readonly Y.YEvent<Y.XmlElement>[],
      transaction: Y.Transaction,
    ): void => {
      if (transaction.origin === RESTORE_ORIGIN) {
        return;
      }

      if (fragment.length === 0) {
        // Local emptyings only: a remote one is the producing peer's to answer - it runs this
        // same guard - and if every open editor answered a shared emptying, each would add its
        // own paragraph. (Two clients emptying concurrently can still merge to two
        // placeholders; the removal branch below cleans each side's own, and the server's
        // parse check remains the backstop for the races beyond that.)
        if (!transaction.local) {
          return;
        }
        doc.transact(() => {
          const paragraph = new Y.XmlElement('paragraph');
          fragment.insert(0, [paragraph]);
          restored = paragraph;
        }, RESTORE_ORIGIN);
        return;
      }

      const placeholder = restored;
      if (placeholder === null) {
        return;
      }

      // The placeholder stops being this guard's to manage the moment somebody types into it,
      // or something other than this guard removes it.
      if (placeholder.parent !== fragment || placeholder.length > 0) {
        restored = null;
        return;
      }

      // Real content is back alongside a placeholder still empty: take the placeholder out, so
      // a redo returns exactly the document the undo removed and not that plus a blank block.
      // Deliberately not gated on `transaction.local` - a colleague's edit arriving beside the
      // placeholder deserves the same cleanup, and it is safe on any origin because the guard
      // only ever deletes the one element it created, and only while that element is empty.
      if (fragment.length > 1) {
        doc.transact(() => {
          const index = fragment.toArray().indexOf(placeholder);
          if (index >= 0) {
            fragment.delete(index, 1);
          }
        }, RESTORE_ORIGIN);
        restored = null;
      }
    };

    fragment.observeDeep(keepAboveTheFloor);
    return () => {
      fragment.unobserveDeep(keepAboveTheFloor);
    };
  }, [doc, fragment]);

  useEffect(() => {
    const sync = startCollabSync({
      itemId,
      doc,
      awareness,
      fragmentName: FRAGMENT_NAME,
      getAccessToken,
      onState: (state) => {
        // A fresh connection means whatever was refused before may not still apply to what is
        // about to be resynced - the banner is about the last update, not a standing fact.
        if (state === 'live') {
          setRefusal(null);
        }
        setSyncState(state);
      },
      onNotice: (notice) => {
        const copy = REFUSAL_COPY[notice.code];
        if (copy !== undefined) {
          setRefusal(copy);
        }
      },
    });

    return () => {
      sync.destroy();
    };
  }, [awareness, doc, getAccessToken, itemId]);

  // Who this cursor belongs to, told to everyone else. The color is picked by client
  // identifier so two tabs of the same person still read as two cursors.
  useEffect(() => {
    awareness.setLocalStateField('user', {
      name: profile?.name ?? 'Someone',
      color: cursorColorFor(doc.clientID),
    });
  }, [awareness, doc, profile]);

  useEffect(() => {
    return () => {
      awareness.destroy();
      doc.destroy();
    };
  }, [awareness, doc]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between pr-8">
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
        <PresenceList awareness={awareness} />
      </div>

      {refusal === null ? null : (
        <p role="alert" className="shrink-0 px-8 py-1.5 text-xs text-accent-text">
          {refusal}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        <SlashMenu editor={editor} />
        <EditorContent editor={editor} className="h-full" />
      </div>

      <SyncFooter state={syncState} />
    </div>
  );
}
