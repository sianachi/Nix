import { Icon } from '@nix/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Editor } from '@tiptap/react';
import {
  Code,
  Heading1,
  Heading2,
  Heading3,
  Image as ImageIcon,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Quote,
  StickyNote,
  Table as TableIcon,
  Type,
  type LucideIcon,
} from 'lucide-react';

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
    keywords: ['table', 'grid', 'rows', 'columns'],
    run: (editor) =>
      editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
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
];

/** Filters the list the way a person typing expects: label first, then keywords. */
export function filterSlashCommands(query: string): readonly SlashCommand[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return SLASH_COMMANDS;
  }

  return SLASH_COMMANDS.filter(
    (command) =>
      command.label.toLowerCase().includes(needle.substring(1, needle.length)) ||
      command.keywords.some((keyword) => keyword.includes(needle)),
  );
}

/**
 * The block inserter, opened with `/`.
 *
 * Filtering happens as you type, and the list is flat because a menu you filter beats a menu you
 * navigate. Escape closes it without inserting anything, which is what a person who typed `/` in
 * the middle of a sentence needs.
 */
export function SlashMenu({ editor }: { readonly editor: Editor }): ReactNode {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // The highlight follows the list it points into, so every event that changes the list - opening,
  // typing, inserting - resets it in the same handler rather than in an effect chasing the change
  // a render later.
  const [highlightedIndex, setHighlightedIndex] = useState(0);
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
        setHighlightedIndex(0);
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
    setHighlightedIndex(0);
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
          setHighlightedIndex(0);
        }}
        onKeyDown={(event) => {
          if (commands.length === 0) {
            return; // No commands to select or navigate
          }

          if (event.key === 'ArrowUp') {
            event.preventDefault();
            setHighlightedIndex((prevIndex) =>
              prevIndex === 0 ? commands.length - 1 : prevIndex - 1,
            );
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            setHighlightedIndex((prevIndex) =>
              prevIndex === commands.length - 1 ? 0 : prevIndex + 1,
            );
          } else if (event.key === 'Enter') {
            event.preventDefault();
            if (commands[highlightedIndex]) {
              insert(commands[highlightedIndex]);
            }
          }
        }}
        className="w-full border-b border-divider bg-transparent px-3 py-2 text-base outline-none"
        placeholder="Filter blocks"
      />

      {commands.length === 0 ? (
        <p className="px-3 py-2 text-sm text-muted">No block matches.</p>
      ) : (
        commands.map((command, index) => (
          <button
            key={command.id}
            type="button"
            role="option"
            aria-selected={index === highlightedIndex}
            onClick={() => {
              insert(command);
            }}
            className={`flex w-full items-center gap-2 px-3 py-2 text-left text-base hover:bg-accent/10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
              index === highlightedIndex ? 'bg-accent/10' : ''
            }`}
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
