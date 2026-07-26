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
      command.label.toLowerCase().includes(needle) ||
      command.keywords.some((keyword) => keyword.includes(needle)),
  );
}
