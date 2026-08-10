import { TOGGLE_LEVELS, type ToggleLevel } from '@nix/editor-schema';
import { Listbox, useListbox } from '@nix/ui';
import { useEffect, useState, type ReactNode } from 'react';
import type { Editor } from '@tiptap/react';
import {
  ChevronRight,
  Code,
  Columns2,
  Heading1,
  Heading2,
  Heading3,
  Image as ImageIcon,
  Link,
  List,
  ListCollapse,
  ListOrdered,
  ListTodo,
  Minus,
  Quote,
  StickyNote,
  Table as TableIcon,
  Type,
  type LucideIcon,
} from 'lucide-react';

import {
  MAX_QUERY as REFERENCE_MAX_QUERY,
  findTrigger as findReferenceTrigger,
} from './reference-menu';

/**
 * Everything `/` can insert.
 *
 * A flat list rather than a nested one on purpose: a menu you filter by typing is faster than a
 * menu you navigate, and grouping only helps when you are browsing. The keywords exist so that
 * "bullet", "ul" and "list" all find the same thing - people reach for the word they know, not
 * the word the schema uses.
 */

export interface SlashCommand {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly icon: LucideIcon;
  readonly keywords: readonly string[];
  readonly run: (editor: Editor) => void;
}

/**
 * The words people reach for when they want a collapsible section, shared by the whole toggle
 * family so "collapse" finds the headed ones too. "details" is the word the schema uses, kept
 * findable for whoever greps the storage format.
 */
const TOGGLE_KEYWORDS = [
  'toggle',
  'details',
  'collapse',
  'collapsible',
  'expand',
  'fold',
  'disclosure',
] as const;

/** One hint per toggle-heading level, mirroring the plain headings' own hints. */
const TOGGLE_HEADING_HINTS: Readonly<Record<ToggleLevel, string>> = {
  1: 'A folding section title',
  2: 'A folding subsection title',
  3: 'A folding minor heading',
};

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    id: 'paragraph',
    label: 'Text',
    hint: 'Plain paragraph',
    icon: Type,
    keywords: ['text', 'paragraph', 'body', 'p'],
    run: (editor) => editor.chain().focus().setParagraph().run(),
  },
  {
    id: 'heading-1',
    label: 'Heading 1',
    hint: 'Section title',
    icon: Heading1,
    keywords: ['heading', 'title', 'h1'],
    run: (editor) => editor.chain().focus().toggleHeading({ level: 1 }).run(),
  },
  {
    id: 'heading-2',
    label: 'Heading 2',
    hint: 'Subsection title',
    icon: Heading2,
    keywords: ['heading', 'subtitle', 'h2'],
    run: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    id: 'heading-3',
    label: 'Heading 3',
    hint: 'Minor heading',
    icon: Heading3,
    keywords: ['heading', 'h3'],
    run: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run(),
  },
  {
    id: 'bullet-list',
    label: 'Bulleted list',
    hint: 'An unordered list',
    icon: List,
    keywords: ['list', 'bullet', 'ul', 'unordered'],
    run: (editor) => editor.chain().focus().toggleBulletList().run(),
  },
  {
    id: 'ordered-list',
    label: 'Numbered list',
    hint: 'An ordered list',
    icon: ListOrdered,
    keywords: ['list', 'number', 'ol', 'ordered'],
    run: (editor) => editor.chain().focus().toggleOrderedList().run(),
  },
  {
    id: 'task-list',
    label: 'Task list',
    hint: 'Checkboxes you can tick',
    icon: ListTodo,
    keywords: ['task', 'todo', 'check', 'checkbox'],
    run: (editor) => editor.chain().focus().toggleTaskList().run(),
  },
  {
    id: 'blockquote',
    label: 'Quote',
    hint: 'Set text apart',
    icon: Quote,
    keywords: ['quote', 'blockquote', 'citation'],
    run: (editor) => editor.chain().focus().toggleBlockquote().run(),
  },
  {
    id: 'code-block',
    label: 'Code block',
    hint: 'Preformatted code',
    icon: Code,
    keywords: ['code', 'snippet', 'pre'],
    run: (editor) => editor.chain().focus().toggleCodeBlock().run(),
  },
  {
    id: 'callout',
    label: 'Callout',
    hint: 'A note that stands out',
    icon: StickyNote,
    keywords: ['callout', 'note', 'admonition', 'warning', 'tip'],
    run: (editor) => editor.chain().focus().wrapIn('callout').run(),
  },
  // The toggles insert through `setDetails`, never `wrapIn`: `details` needs a summary child
  // and a content child, and `wrapIn` can only fold the block into a single parent - it fails
  // silently against this schema. `setDetails` builds the pair and moves the caret into the
  // summary, so what somebody types next names the section.
  {
    id: 'toggle',
    label: 'Toggle',
    hint: 'A section that folds away',
    icon: ChevronRight,
    keywords: TOGGLE_KEYWORDS,
    run: (editor) => editor.chain().focus().setDetails().run(),
  },
  // One entry per level, mirroring the plain headings above: the levels are the schema's
  // `TOGGLE_LEVELS`, so a level added there appears here without anyone remembering to count.
  ...TOGGLE_LEVELS.map((level): SlashCommand => ({
    id: `toggle-heading-${String(level)}`,
    label: `Toggle heading ${String(level)}`,
    hint: TOGGLE_HEADING_HINTS[level],
    icon: ListCollapse,
    keywords: [...TOGGLE_KEYWORDS, 'heading', `h${String(level)}`],
    run: (editor) =>
      editor.chain().focus().setDetails().updateAttributes('details', { toggleLevel: level }).run(),
  })),
  {
    id: 'divider',
    label: 'Divider',
    hint: 'A horizontal rule',
    icon: Minus,
    keywords: ['divider', 'rule', 'hr', 'separator'],
    run: (editor) => editor.chain().focus().setHorizontalRule().run(),
  },
  {
    id: 'table',
    label: 'Table',
    hint: 'Three columns, with a header row',
    icon: TableIcon,
    // Deliberately not "columns". A table has columns, but so does the block *named* Columns,
    // and a flat filter has no way to prefer the exact label - so typing the one word that names
    // a command found the other command first and Enter inserted a table. "grid" and "rows"
    // still find this, and the hint says "Three columns, with a header row".
    keywords: ['table', 'grid', 'rows'],
    run: (editor) =>
      editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    id: 'columns',
    label: 'Columns',
    hint: 'Two columns, side by side',
    icon: Columns2,
    keywords: ['columns', 'column', 'side', 'split', 'layout'],
    // Two, because two is what somebody who types "/columns" means and because a row can be
    // widened afterwards - `addColumnToRow`, on the toolbar and on Mod+Alt+Enter, goes up to the
    // four the schema documents - and there is no undo for a menu that guessed three.
    run: (editor) => editor.chain().focus().insertColumnBlock({ columns: 2 }).run(),
  },
  {
    id: 'image',
    label: 'Image',
    hint: 'By URL',
    icon: ImageIcon,
    keywords: ['image', 'picture', 'photo', 'figure'],
    run: (editor: Editor): void => {
      // By URL in this phase. Uploads need the media service, and offering a file picker that
      // cannot upload would be worse than not offering one.
      const src: string | null = globalThis.prompt('Image URL');
      if (src !== null && src.length > 0) {
        editor.chain().focus().setImage({ src }).run();
      }
    },
  },
  {
    id: 'link-item',
    label: 'Link to item',
    hint: 'Reference another document',
    icon: Link,
    keywords: ['link', 'reference', 'wiki', 'mention', 'backlink', 'item', 'document'],
    // Written as the trigger it abbreviates rather than opening the picker directly: the
    // reference menu reads `[[` out of the document on every transaction, so inserting the
    // trigger *is* opening the picker - one opening mechanism, not two to keep in step. The
    // insertion point is always a word start, because this menu's own trigger required one.
    run: (editor) => editor.chain().focus().insertContent('[[').run(),
  },
];

/**
 * Filters the list the way a person typing expects: label first, then keywords.
 *
 * The label arm used to read `needle.substring(1, needle.length)`, dropping the needle's first
 * character - a leftover from when the query still carried the `/` that opened the menu. It went
 * unnoticed because the shortened needle is a substring of the real one, so every correct match
 * still matched; what it also did was match things it should not. Searching for "able" found
 * "Table", and so did searching for "zable".
 */
export function filterSlashCommands(query: string): readonly SlashCommand[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return SLASH_COMMANDS;
  }

  return SLASH_COMMANDS.filter(
    (command) =>
      command.label.toLowerCase().includes(needle) ||
      command.keywords.some((keyword) => keyword.includes(needle)),
  );
}

/**
 * How far into `/` somebody can type before it stops being a command and goes back to being
 * prose. Longer than any label or keyword, with room for a typo; past it, this is a sentence
 * that happens to start with a slash.
 */
const MAX_QUERY = 24;

/** An open `/` trigger: where its text starts and what has been typed after it. */
export interface FoundSlashTrigger {
  readonly start: number;
  readonly query: string;
}

/**
 * Finds an open `/` in the text before the caret.
 *
 * The same contract as the reference picker's `findTrigger`, for the same reasons. A slash only
 * counts at the start of a word - after whitespace, or at the very start of the block - so
 * "and/or" and the slashes inside a URL stay text. The query may contain spaces, because the
 * labels do ("Task list"); a newline ends it, and so does a query longer than any command name.
 * A *second* slash re-anchors the search and then fails the word-start test, which is what closes
 * the menu when somebody carries on typing a path.
 *
 * Exported for its own tests: it is pure string handling, and the alternative is asserting it
 * through an editor, a document and a selection.
 */
export function findSlashTrigger(text: string, truncated = false): FoundSlashTrigger | null {
  const start = text.lastIndexOf('/');
  if (start < 0) {
    return null;
  }

  // Position zero is the start of a word only when it really is the start of the block. When the
  // caller handed over a window cut out of a longer paragraph, the character before it is unknown.
  const before = start === 0 ? (truncated ? undefined : ' ') : text[start - 1];
  if (before === undefined || !/\s/.test(before)) {
    return null;
  }

  const query = text.slice(start + 1);
  if (query.length > MAX_QUERY || query.includes('\n')) {
    return null;
  }

  return { start, query };
}

/** Where the menu sits, and what it is filtering. */
interface OpenTrigger {
  /** Document positions of the trigger's text - the `/` and the query - so it can be removed exactly. */
  readonly from: number;
  readonly to: number;
  readonly query: string;
  /** Viewport coordinates of the caret. */
  readonly left: number;
  readonly top: number;
}

/**
 * The block inserter, opened by typing `/` at the start of a word.
 *
 * **The same shape as the reference picker, deliberately.** The query lives in the document and
 * focus never leaves it; the trigger is read back out of the document on every transaction, and
 * the keys are taken off the editor's own element while the menu is open. The previous version
 * held its query in a field of its own and moved focus into it, and both reported bugs fell out
 * of exactly that: the `/` keystroke raced the focus move and landed in the field - so the menu
 * opened showing "No block matches" until a backspace cleared the stray slash - and the keyboard
 * model was attached to a field the focus had not reliably reached. Its removal arithmetic also
 * assumed the query had been typed into the document when it never was, so committing a command
 * deleted that many characters of real content.
 *
 * Escape closes it without unwriting anything: the `/` somebody typed is theirs. Committing a
 * command removes the trigger text and inserts the block in its place.
 */
export function SlashMenu({ editor }: { readonly editor: Editor }): ReactNode {
  const [trigger, setTrigger] = useState<OpenTrigger | null>(null);
  const [dismissed, setDismissed] = useState<number | null>(null);

  // Read from the document on every transaction, because the document is where the trigger lives.
  useEffect(() => {
    function readTrigger(): void {
      const { state } = editor;
      const { from, empty } = state.selection;

      if (!empty) {
        setTrigger(null);
        return;
      }

      // The window is the *reference* picker's, not this menu's own smaller one, because the
      // deferral below has to see everything that picker can: a `[[` that sits further back than
      // a slash query is long would otherwise be invisible here, and both menus would open at
      // once over the same caret.
      const at = state.doc.resolve(from);
      const window = Math.max(0, at.parentOffset - (REFERENCE_MAX_QUERY + 2));
      const text = at.parent.textBetween(window, at.parentOffset, '\n', '\n');
      const truncated = window > 0;

      // The reference picker wins. `[[quarterly /q2` is somebody typing a slash inside a link
      // query, and two floating menus fighting over the same arrow keys helps nobody.
      if (findReferenceTrigger(text, truncated) !== null) {
        setTrigger(null);
        return;
      }

      const found = findSlashTrigger(text, truncated);
      if (found === null) {
        setTrigger(null);
        return;
      }

      const start = from - (text.length - found.start);
      const coords = editor.view.coordsAtPos(from);

      setTrigger({
        from: start,
        to: from,
        query: found.query,
        left: coords.left,
        top: coords.bottom,
      });
    }

    // Closed when the editor loses the focus: the trigger derives from the document's selection,
    // which survives a blur, so clicking into the sidebar with `/` half-typed would otherwise
    // leave the menu floating with its keyboard handler bound to an element nobody is typing in.
    function onBlur(): void {
      setTrigger(null);
    }

    readTrigger();
    editor.on('transaction', readTrigger);
    editor.on('blur', onBlur);

    return () => {
      editor.off('transaction', readTrigger);
      editor.off('blur', onBlur);
    };
  }, [editor]);

  // Escape closes a trigger without unwriting it, and the dismissal is of one position: typing
  // another `/` elsewhere opens the menu again.
  const open = trigger !== null && trigger.from !== dismissed;
  const query = trigger?.query ?? '';

  const commands = filterSlashCommands(query);
  const options = commands.map((command) => ({
    id: command.id,
    label: command.label,
    hint: command.hint,
    icon: command.icon,
  }));

  const listbox = useListbox(options, (_option, index) => {
    const command = commands[index];
    if (command === undefined || trigger === null) {
      return;
    }

    // The trigger's text - the `/` and the query, at the positions just read from the document -
    // comes out first, then the command runs against the caret it leaves behind. Nothing else is
    // touched, which is what the field-based version got wrong: its arithmetic deleted characters
    // the document actually owned.
    editor.chain().focus().deleteRange({ from: trigger.from, to: trigger.to }).run();
    command.run(editor);
  });

  // The keys are taken off the editor's own element, because that is what holds the focus. Capture
  // phase, so the arrow keys move the highlight rather than the caret while the menu is open.
  useEffect(() => {
    if (!open) {
      return;
    }

    const dom = editor.view.dom;
    const dismissAt = trigger.from;

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        // The innermost open layer wins and stops the event, so Escape here does not also close
        // the pane behind it. See `command-palette.tsx` for the full convention.
        event.preventDefault();
        event.stopPropagation();
        setDismissed(dismissAt);
        return;
      }

      listbox.onKeyDown(event);
    }

    dom.addEventListener('keydown', onKeyDown, true);
    return () => {
      dom.removeEventListener('keydown', onKeyDown, true);
    };
  }, [editor, listbox, open, trigger]);

  // `aria-activedescendant` on the editor itself. It is a textbox with a listbox attached, which
  // is what the attribute is for; without it the highlight moves silently for anybody who cannot
  // see it. The reference picker sets the same attributes; the deferral above is what guarantees
  // the two are never open - and never writing here - at once.
  useEffect(() => {
    const dom = editor.view.dom;
    if (!open) {
      dom.removeAttribute('aria-activedescendant');
      dom.removeAttribute('aria-controls');
      return;
    }

    dom.setAttribute('aria-controls', listbox.id);
    if (listbox.activeOptionId === undefined) {
      dom.removeAttribute('aria-activedescendant');
    } else {
      dom.setAttribute('aria-activedescendant', listbox.activeOptionId);
    }

    return () => {
      dom.removeAttribute('aria-activedescendant');
      dom.removeAttribute('aria-controls');
    };
  }, [editor, listbox.activeOptionId, listbox.id, open]);

  if (!open) {
    return null;
  }

  return (
    <div
      // Positioned against the caret in viewport coordinates, so it follows the text rather than
      // the scroller - which the editor does under it.
      style={{ left: trigger.left, top: trigger.top }} // design-token-exempt: a caret's position is a runtime measurement, not a scale step.
      className="fixed z-20 mt-1 flex max-h-[280px] w-[280px] flex-col overflow-y-auto border border-divider bg-background shadow-md"
    >
      <Listbox
        label="Insert a block"
        options={options}
        controller={listbox}
        emptyMessage="No block matches."
      />
    </div>
  );
}
